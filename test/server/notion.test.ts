import { describe, expect, it, vi } from 'vitest';
import { NotionWorkspace, PROPS, SCHEMA, fromRichText, pageToThread, toRichText } from '../../server/src/stores/notion';
import { pin } from './helpers';

const ana = { id: 'u-ana', name: 'Ana Ruiz' };

describe('rich text', () => {
  it('turns @mentions into Notion user mentions and back', () => {
    const rich = toRichText('Hi @Ana Ruiz, see this', [ana]);
    expect(rich).toEqual([
      { type: 'text', text: { content: 'Hi ' } },
      { type: 'mention', mention: { type: 'user', user: { id: 'u-ana' } } },
      { type: 'text', text: { content: ', see this' } },
    ]);
    // Notion fills in plain_text on the way back.
    const read = fromRichText([
      { ...rich[0], plain_text: 'Hi ' },
      { ...rich[1], plain_text: '@Ana Ruiz' },
      { ...rich[2], plain_text: ', see this' },
    ] as any);
    expect(read).toEqual({ body: 'Hi @Ana Ruiz, see this', mentions: [ana] });
  });

  it('splits long text into 2000-character chunks', () => {
    const rich = toRichText('x'.repeat(4500), []);
    expect(rich.map((r: any) => r.text.content.length)).toEqual([2000, 2000, 500]);
  });
});

const rt = (s: string) => [{ type: 'text', text: { content: s }, plain_text: s }];

function notionPage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'page-1',
    created_time: '2026-10-20T10:00:00.000Z',
    last_edited_time: '2026-10-20T10:05:00.000Z',
    parent: { type: 'data_source_id', data_source_id: 'ds-1' },
    properties: {
      [PROPS.title]: { title: rt('Make it bolder') },
      [PROPS.page]: { rich_text: rt('/') },
      [PROPS.link]: { url: 'http://proto.test/' },
      [PROPS.status]: { select: { name: 'Resolved' } },
      [PROPS.reviewer]: { people: [{ id: 'u-ana', name: 'Ana Ruiz', avatar_url: 'https://a/b.png' }] },
      [PROPS.mentioned]: { people: [] },
      [PROPS.resolvedBy]: { people: [{ id: 'u-ana', name: 'Ana Ruiz' }] },
      [PROPS.count]: { number: 3 },
      [PROPS.pin]: { rich_text: rt(JSON.stringify(pin)) },
      [PROPS.clientId]: { rich_text: rt('client-1') },
    },
    ...overrides,
  };
}

describe('pageToThread', () => {
  it('maps a row to a thread summary', () => {
    const t = pageToThread(notionPage() as any, 'db-1')!;
    expect(t).toMatchObject({
      id: 'client-1',
      remoteId: 'page-1',
      project: 'db-1',
      status: 'resolved',
      commentCount: 3,
      pin,
      createdBy: { id: 'u-ana', name: 'Ana Ruiz', avatarUrl: 'https://a/b.png' },
      resolvedBy: { id: 'u-ana' },
    });
    expect(t.comments[0].body).toBe('Make it bolder');
  });

  it('ignores rows that were not created by the overlay', () => {
    const page = notionPage();
    (page.properties as any)[PROPS.pin] = { rich_text: [] };
    expect(pageToThread(page as any, 'db-1')).toBeNull();
  });
});

const DB = 'a'.repeat(32);
const HUB = 'b'.repeat(32);
const FOLDER = 'c'.repeat(32);
const schema = Object.fromEntries(Object.entries(SCHEMA).map(([name, type]) => [name, { type }]));

function mockNotion(responses: Record<string, unknown>) {
  const calls: { method: string; path: string; body: any }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const path = url.replace('https://api.notion.com/v1', '');
    calls.push({ method: init.method!, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${init.method} ${path.split('?')[0]}`;
    return new Response(JSON.stringify(responses[key] ?? { code: 'object_not_found', message: 'nope' }), { status: key in responses ? 200 : 404 });
  });
  return { calls, workspace: new NotionWorkspace({ token: 't', hubPageId: `https://www.notion.so/acme/Hub-${HUB}?pvs=4`, fetch: fetchImpl as unknown as typeof fetch }) };
}

/** A feedback database two levels under the hub: Hub → Folder → database. */
const tree = {
  [`GET /databases/${DB}`]: { id: DB, parent: { type: 'page_id', page_id: FOLDER }, data_sources: [{ id: 'ds-1' }] },
  [`GET /pages/${FOLDER}`]: { id: FOLDER, parent: { type: 'page_id', page_id: HUB } },
  'GET /data_sources/ds-1': { properties: schema },
};

describe('NotionWorkspace', () => {
  it('opens a feedback database anywhere under the hub page, from a link', async () => {
    const { workspace } = mockNotion(tree);
    const store = await workspace.open(`https://www.notion.so/acme/Checkout-Feedback-${DB}?v=123`);
    expect(store.id).toBe(DB);
  });

  it('refuses databases outside the hub page', async () => {
    const { workspace } = mockNotion({ ...tree, [`GET /pages/${FOLDER}`]: { id: FOLDER, parent: { type: 'workspace', workspace: true } } });
    await expect(workspace.open(DB)).rejects.toThrow(/isn’t inside the hub page/);
  });

  it('refuses databases without the expected columns', async () => {
    const { workspace } = mockNotion({ ...tree, 'GET /data_sources/ds-1': { properties: { Feedback: { type: 'title' } } } });
    await expect(workspace.open(DB)).rejects.toThrow(/missing columns: Page \(rich_text\)/);
  });

  it('refuses links that are not databases the integration can see', async () => {
    const { workspace } = mockNotion({});
    await expect(workspace.open(DB)).rejects.toThrow(/can’t be used/);
    await expect(workspace.open('not a link')).rejects.toThrow(/Notion database link/);
  });

  it('checks a database once, then reuses it', async () => {
    const { workspace, calls } = mockNotion(tree);
    await workspace.open(DB);
    await workspace.open(DB);
    expect(calls.filter((c) => c.path === `/databases/${DB}`)).toHaveLength(1);
  });
});

describe('NotionStore', () => {
  it('only returns rows from its own data source', async () => {
    const { workspace } = mockNotion({ ...tree, 'GET /pages/page-1': notionPage({ parent: { type: 'data_source_id', data_source_id: 'other' } }) });
    expect(await (await workspace.open(DB)).getThread('page-1')).toBeNull();
  });

  it('treats trashed rows as missing', async () => {
    const { workspace } = mockNotion({ ...tree, 'GET /pages/page-1': notionPage({ in_trash: true }) });
    expect(await (await workspace.open(DB)).getThread('page-1')).toBeNull();
  });

  it('creates a row, then posts the first comment under the reviewer’s name', async () => {
    const { calls, workspace } = mockNotion({
      ...tree,
      'POST /pages': notionPage({ properties: { ...notionPage().properties, [PROPS.status]: { select: { name: 'Open' } } } }),
      'POST /comments': { id: 'c1', created_time: '2026-10-20T10:00:00.000Z', created_by: { id: 'bot' }, rich_text: rt('Make it bolder'), display_name: { type: 'custom', resolved_name: 'Ana Ruiz' } },
    });
    const store = await workspace.open(DB);
    calls.length = 0;
    const t = await store.createThread({ clientId: 'client-1', page: '/', url: '', pin, body: 'Make it bolder', mentions: [], author: ana });

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /pages', 'POST /comments']);
    expect(calls[0].body.parent).toEqual({ type: 'data_source_id', data_source_id: 'ds-1' });
    expect(calls[0].body.properties[PROPS.reviewer]).toEqual({ people: [{ id: 'u-ana' }] });
    expect(calls[1].body.display_name).toEqual({ type: 'custom', custom: { name: 'Ana Ruiz' } });
    expect(t.comments[0].author).toEqual(ana);
    expect(t.status).toBe('open');
    expect(t.project).toBe(DB);
  });
});
