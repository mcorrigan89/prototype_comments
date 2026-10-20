import { describe, expect, it, vi } from 'vitest';
import { DATABASE_PROPERTIES, NotionWorkspace, PROPS, SCHEMA, TABLE_LAYOUT, fromRichText, pageToThread, toRichText } from '../../server/src/stores/notion';
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

const PAGE = 'a'.repeat(32); // the prototype's page, as linked in data-notion
const DB = 'b'.repeat(32); // the comments database inside it
const schema = Object.fromEntries(Object.entries(SCHEMA).map(([name, type]) => [name, { type }]));

function mockNotion(responses: Record<string, unknown>) {
  const calls: { method: string; path: string; body: any }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const path = url.replace('https://api.notion.com/v1', '');
    calls.push({ method: init.method!, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${init.method} ${path.split('?')[0]}`;
    return new Response(JSON.stringify(responses[key] ?? { code: 'object_not_found', message: 'nope' }), { status: key in responses ? 200 : 404 });
  });
  return { calls, workspace: new NotionWorkspace({ token: 't', fetch: fetchImpl as unknown as typeof fetch }) };
}

const pageLink = `https://app.notion.com/p/govwell/Prototype-Feedback-Kite-${PAGE}?source=copy_link`;
/** A shared page with a comments database already inside it. */
const pageWithComments = {
  [`GET /pages/${PAGE}`]: { id: PAGE },
  [`GET /blocks/${PAGE}/children`]: { results: [{ id: 'para', type: 'paragraph' }, { id: DB, type: 'child_database' }], has_more: false, next_cursor: null },
  [`GET /databases/${DB}`]: { id: DB, data_sources: [{ id: 'ds-1' }] },
  'GET /data_sources/ds-1': { properties: schema },
};

describe('NotionWorkspace', () => {
  it('finds the comments database inside a prototype page', async () => {
    const { workspace } = mockNotion(pageWithComments);
    const store = await workspace.open(pageLink);
    expect(store.id).toBe(PAGE);
  });

  it('reads a page with no comments yet as empty, without creating anything', async () => {
    const { workspace, calls } = mockNotion({
      [`GET /pages/${PAGE}`]: { id: PAGE },
      [`GET /blocks/${PAGE}/children`]: { results: [], has_more: false, next_cursor: null },
    });
    const store = await workspace.open(pageLink);
    expect(await store.listThreads()).toEqual([]);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('creates the comments database inside the page on the first write', async () => {
    const { workspace, calls } = mockNotion({
      [`GET /pages/${PAGE}`]: { id: PAGE },
      [`GET /blocks/${PAGE}/children`]: { results: [], has_more: false, next_cursor: null },
      'POST /databases': { id: DB, data_sources: [{ id: 'ds-1' }] },
      'GET /data_sources/ds-1': { properties: Object.fromEntries(Object.entries(schema).map(([n, p], i) => [n, { ...p, id: `p${i}` }])) },
      'GET /views': { results: [{ id: 'view-1' }], has_more: false, next_cursor: null },
      'PATCH /views/view-1': { id: 'view-1' },
    });
    await workspace.open(pageLink); // a read first: cached as empty
    const store = await workspace.open(pageLink, { create: true });
    const create = calls.find((c) => c.method === 'POST' && c.path === '/databases')!;
    expect(create.body.parent).toEqual({ type: 'page_id', page_id: PAGE });
    expect(create.body.title[0].text.content).toBe('Comments');
    expect(Object.keys(create.body.initial_data_source.properties).sort()).toEqual(Object.keys(SCHEMA).sort());
    expect(create.body.is_inline).toBe(true);
    expect(store.id).toBe(PAGE);

    // The table is arranged for people: useful columns first, machine data hidden.
    const view = calls.find((c) => c.method === 'PATCH' && c.path === '/views/view-1')!.body.configuration.properties;
    const ids = Object.fromEntries(Object.keys(schema).map((n, i) => [`p${i}`, n]));
    expect(view.slice(0, 3).map((p: any) => ids[p.property_id])).toEqual([PROPS.title, PROPS.status, PROPS.reviewer]);
    expect(view.filter((p: any) => !p.visible).map((p: any) => ids[p.property_id])).toEqual([PROPS.pin, PROPS.clientId]);
  });

  it('skips databases in the page that are not comments databases', async () => {
    const { workspace, calls } = mockNotion({
      ...pageWithComments,
      'GET /data_sources/ds-1': { properties: { Name: { type: 'title' } } },
      'POST /databases': { id: 'c'.repeat(32), data_sources: [{ id: 'ds-2' }] },
      'GET /data_sources/ds-2': { properties: schema },
    });
    await workspace.open(pageLink, { create: true });
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/databases')).toHaveLength(1);
  });

  it('accepts a link straight to a comments database', async () => {
    const { workspace } = mockNotion({ [`GET /databases/${DB}`]: { id: DB, data_sources: [{ id: 'ds-1' }] }, 'GET /data_sources/ds-1': { properties: schema } });
    expect((await workspace.open(DB)).id).toBe(DB);
  });

  it('rejects a database link without the comment columns', async () => {
    const { workspace } = mockNotion({ [`GET /databases/${DB}`]: { id: DB, data_sources: [{ id: 'ds-1' }] }, 'GET /data_sources/ds-1': { properties: {} } });
    await expect(workspace.open(DB)).rejects.toThrow(/doesn’t have the comment columns/);
  });

  it('explains how to connect a page the integration can’t see', async () => {
    const { workspace } = mockNotion({});
    await expect(workspace.open(pageLink)).rejects.toThrow(/Connections/);
    await expect(workspace.open('not a link')).rejects.toThrow(/Notion page link/);
  });

  it('resolves a link once, then reuses it', async () => {
    const { workspace, calls } = mockNotion(pageWithComments);
    await workspace.open(pageLink);
    await workspace.open(pageLink);
    expect(calls.filter((c) => c.path.startsWith(`/blocks/${PAGE}`))).toHaveLength(1);
  });
});

it('creates databases with every column the backend checks for, and lays all of them out', () => {
  const created = Object.fromEntries(Object.entries(DATABASE_PROPERTIES).map(([name, def]) => [name, Object.keys(def)[0]]));
  expect(created).toEqual(SCHEMA);
  expect(TABLE_LAYOUT.map((c) => c.name).sort()).toEqual(Object.keys(SCHEMA).sort());
});

describe('NotionStore', () => {
  it('only returns rows from its own data source', async () => {
    const { workspace } = mockNotion({ ...pageWithComments, 'GET /pages/page-1': notionPage({ parent: { type: 'data_source_id', data_source_id: 'other' } }) });
    expect(await (await workspace.open(pageLink)).getThread('page-1')).toBeNull();
  });

  it('treats trashed rows as missing', async () => {
    const { workspace } = mockNotion({ ...pageWithComments, 'GET /pages/page-1': notionPage({ in_trash: true }) });
    expect(await (await workspace.open(pageLink)).getThread('page-1')).toBeNull();
  });

  it('creates a row, then posts the first comment under the reviewer’s name', async () => {
    const { calls, workspace } = mockNotion({
      ...pageWithComments,
      'POST /pages': notionPage({ properties: { ...notionPage().properties, [PROPS.status]: { select: { name: 'Open' } } } }),
      'POST /comments': { id: 'c1', created_time: '2026-10-20T10:00:00.000Z', created_by: { id: 'bot' }, rich_text: rt('Make it bolder'), display_name: { type: 'custom', resolved_name: 'Ana Ruiz' } },
    });
    const store = await workspace.open(pageLink);
    calls.length = 0;
    const t = await store.createThread({ clientId: 'client-1', page: '/', url: '', pin, body: 'Make it bolder', mentions: [], author: ana });

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /pages', 'POST /comments']);
    expect(calls[0].body.parent).toEqual({ type: 'data_source_id', data_source_id: 'ds-1' });
    expect(calls[0].body.properties[PROPS.reviewer]).toEqual({ people: [{ id: 'u-ana' }] });
    expect(calls[1].body.display_name).toEqual({ type: 'custom', custom: { name: 'Ana Ruiz' } });
    expect(t.comments[0].author).toEqual(ana);
    expect(t.status).toBe('open');
    expect(t.project).toBe(PAGE);
  });
});
