import type { Comment, Pin, Thread, ThreadStatus, User } from '../../../src/types';
import { HttpError, badRequest } from '../http';
import { notionIdFrom, type NewThreadInput, type Store, type Workspace } from '../ports';

export const NOTION_API = 'https://api.notion.com/v1';
/** 2025-09-03 introduced data sources; 2026-03-11 renamed `archived` to `in_trash`. */
export const NOTION_VERSION = '2026-03-11';

/** Column names in a feedback database (see server/scripts/notion-setup.ts). */
export const PROPS = {
  title: 'Feedback',
  page: 'Page',
  link: 'Link',
  status: 'Status',
  reviewer: 'Reviewer',
  mentioned: 'Mentioned',
  resolvedBy: 'Resolved by',
  count: 'Comment count',
  pin: 'Pin',
  clientId: 'Client ID',
} as const;

/** Column types a database must have to be used as a feedback database. */
export const SCHEMA: Record<(typeof PROPS)[keyof typeof PROPS], string> = {
  [PROPS.title]: 'title',
  [PROPS.page]: 'rich_text',
  [PROPS.link]: 'url',
  [PROPS.status]: 'select',
  [PROPS.reviewer]: 'people',
  [PROPS.mentioned]: 'people',
  [PROPS.resolvedBy]: 'people',
  [PROPS.count]: 'number',
  [PROPS.pin]: 'rich_text',
  [PROPS.clientId]: 'rich_text',
};

export const STATUS_NAMES: Record<ThreadStatus, string> = { open: 'Open', resolved: 'Resolved' };

const TEXT_LIMIT = 2000; // per rich-text object
const RICH_TEXT_ITEMS = 100; // per array
const USERS_TTL_MS = 10 * 60 * 1000;
/** How long a checked database link stays trusted before it's checked again. */
const DATABASE_TTL_MS = 10 * 60 * 1000;
/** How far up the page tree to look for the hub page. */
const MAX_DEPTH = 8;

export class NotionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`Notion ${status} ${code}: ${message}`);
  }
}

// ---------- Notion JSON shapes (only the fields we use) ----------

type RichText =
  | { type: 'text'; text: { content: string }; plain_text?: string }
  | { type: 'mention'; mention: { type: 'user'; user: { id: string } } | { type: string }; plain_text?: string };

interface NotionPerson {
  object?: 'user';
  id: string;
  type?: 'person' | 'bot';
  name?: string | null;
  avatar_url?: string | null;
  person?: { email?: string };
}

interface NotionPage {
  id: string;
  created_time: string;
  last_edited_time: string;
  in_trash?: boolean;
  archived?: boolean;
  parent?: { type: string; data_source_id?: string; database_id?: string };
  properties: Record<string, any>;
}

interface NotionComment {
  id: string;
  created_time: string;
  created_by: { id: string };
  rich_text: RichText[];
  display_name?: { type: string; resolved_name?: string };
}

interface ListResult<T> {
  results: T[];
  has_more: boolean;
  next_cursor: string | null;
}

// ---------- mapping (exported for tests) ----------

const normalizeId = (id: string) => id.replace(/-/g, '').toLowerCase();

export function textChunks(value: string): RichText[] {
  const out: RichText[] = [];
  for (let i = 0; i < value.length; i += TEXT_LIMIT) out.push({ type: 'text', text: { content: value.slice(i, i + TEXT_LIMIT) } });
  return out;
}

/** Comment text → Notion rich text, turning "@Name" into real user mentions (which notify them). */
export function toRichText(body: string, mentions: User[]): RichText[] {
  const byName = new Map(mentions.map((m) => [m.name, m]));
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  if (!names.length) return textChunks(body).slice(0, RICH_TEXT_ITEMS);
  const re = new RegExp(`@(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g');
  const out: RichText[] = [];
  let last = 0;
  for (const match of body.matchAll(re)) {
    out.push(...textChunks(body.slice(last, match.index)));
    out.push({ type: 'mention', mention: { type: 'user', user: { id: byName.get(match[1])!.id } } });
    last = match.index + match[0].length;
  }
  out.push(...textChunks(body.slice(last)));
  return out.slice(0, RICH_TEXT_ITEMS);
}

export const plainText = (items: RichText[] | undefined) => (items ?? []).map((i) => i.plain_text ?? '').join('');

export function fromRichText(items: RichText[]): { body: string; mentions: User[] } {
  const mentions: User[] = [];
  for (const item of items) {
    if (item.type === 'mention' && item.mention.type === 'user' && 'user' in item.mention) {
      mentions.push({ id: item.mention.user.id, name: (item.plain_text ?? '').replace(/^@/, '') });
    }
  }
  return { body: plainText(items), mentions };
}

export function personToUser(p: NotionPerson): User {
  return {
    id: p.id,
    name: p.name || 'Unknown',
    ...(p.avatar_url ? { avatarUrl: p.avatar_url } : {}),
    ...(p.person?.email ? { email: p.person.email } : {}),
  };
}

/** A database row → thread summary. Returns null for rows that weren't made by the overlay. */
export function pageToThread(page: NotionPage, databaseId: string): Thread | null {
  const props = page.properties;
  let pin: Pin;
  try {
    pin = JSON.parse(plainText(props[PROPS.pin]?.rich_text));
    if (!pin?.selector && !pin?.page) return null;
  } catch {
    return null;
  }
  const people = (prop: any): User[] => (prop?.people ?? []).map(personToUser);
  const reviewer = people(props[PROPS.reviewer])[0] ?? { id: 'unknown', name: 'Unknown' };
  const resolvedBy = people(props[PROPS.resolvedBy])[0];
  const status: ThreadStatus = props[PROPS.status]?.select?.name === STATUS_NAMES.resolved ? 'resolved' : 'open';
  return {
    id: plainText(props[PROPS.clientId]?.rich_text) || page.id,
    remoteId: page.id,
    project: databaseId,
    page: plainText(props[PROPS.page]?.rich_text),
    url: props[PROPS.link]?.url ?? '',
    pin,
    status,
    createdBy: reviewer,
    createdAt: page.created_time,
    updatedAt: page.last_edited_time,
    ...(status === 'resolved' && resolvedBy ? { resolvedBy } : {}),
    comments: [
      {
        id: `summary-${page.id}`,
        author: reviewer,
        body: plainText(props[PROPS.title]?.title),
        mentions: people(props[PROPS.mentioned]),
        createdAt: page.created_time,
      },
    ],
    commentCount: props[PROPS.count]?.number ?? 1,
  };
}

/**
 * Notion records comments posted through the API as written by the integration,
 * with our custom display name. Map them back to people by that name.
 */
export function notionCommentToComment(c: NotionComment, people: User[]): Comment {
  const byId = people.find((p) => p.id === c.created_by.id);
  const name = c.display_name?.resolved_name;
  const byName = !byId && name ? people.find((p) => p.name === name) : undefined;
  const author = byId ?? byName ?? { id: c.created_by.id, name: name || 'Unknown' };
  return { id: c.id, author, ...fromRichText(c.rich_text), createdAt: c.created_time };
}

// ---------- client ----------

type Fetch = typeof fetch;

export function notionRequest(token: string, fetchImpl: Fetch = fetch) {
  return async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(`${NOTION_API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'notion-version': NOTION_VERSION,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (res.status === 429 && attempt < 2) {
        const wait = Math.min(Number(res.headers.get('retry-after')) || 1, 5);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      const data = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new NotionError(res.status, data.code ?? 'unknown', data.message ?? res.statusText);
      return data as T;
    }
  };
}

type Request = ReturnType<typeof notionRequest>;

interface NotionParent {
  type: string;
  page_id?: string;
  block_id?: string;
  database_id?: string;
  data_source_id?: string;
}

export interface NotionWorkspaceOptions {
  token: string;
  /** The page every feedback database must live under. */
  hubPageId: string;
  fetch?: Fetch;
}

/**
 * Resolves data-notion links to feedback databases. The link comes from a script
 * tag anyone can edit, so each one is checked before use: it must be a database
 * somewhere under the hub page, with the expected columns.
 */
export class NotionWorkspace implements Workspace {
  private readonly request: Request;
  private readonly hubPageId: string;
  private readonly databases = new Map<string, { at: number; store: Promise<NotionStore> }>();
  private users: { at: number; list: User[] } | null = null;

  constructor({ token, hubPageId, fetch: fetchImpl }: NotionWorkspaceOptions) {
    this.request = notionRequest(token, fetchImpl);
    const hub = notionIdFrom(hubPageId);
    if (!hub) throw new Error('NOTION_HUB_PAGE_ID must be a Notion page link or id');
    this.hubPageId = hub;
  }

  open(ref: string): Promise<Store> {
    const id = notionIdFrom(ref);
    if (!id) return Promise.reject(badRequest('data-notion should be a Notion database link'));
    const cached = this.databases.get(id);
    if (cached && Date.now() - cached.at < DATABASE_TTL_MS) return cached.store;
    const store = this.check(id);
    this.databases.set(id, { at: Date.now(), store });
    store.catch(() => this.databases.delete(id)); // don't remember failures
    return store;
  }

  private async check(id: string): Promise<NotionStore> {
    const notUsable = (why: string) => new HttpError(404, `That Notion link can’t be used for comments: ${why}`, 'not_found');

    let database: { id: string; parent: NotionParent; in_trash?: boolean; data_sources?: { id: string }[] };
    try {
      database = await this.request('GET', `/databases/${id}`);
    } catch (err) {
      if (err instanceof NotionError && (err.status === 404 || err.status === 400)) {
        throw notUsable('it isn’t a database the integration can see. Is it inside the hub page?');
      }
      throw err;
    }
    if (database.in_trash) throw notUsable('the database is in the trash');
    if (!(await this.isUnderHub(database.parent))) throw notUsable('the database isn’t inside the hub page');

    const dataSourceId = database.data_sources?.[0]?.id;
    if (!dataSourceId) throw notUsable('the database has no data source');
    const source: { properties: Record<string, { type: string }> } = await this.request('GET', `/data_sources/${dataSourceId}`);
    const missing = Object.entries(SCHEMA)
      .filter(([name, type]) => source.properties[name]?.type !== type)
      .map(([name, type]) => `${name} (${type})`);
    if (missing.length) throw notUsable(`it’s missing columns: ${missing.join(', ')}. Duplicate an existing feedback database, or use npm run notion:setup.`);

    return new NotionStore(this.request, normalizeId(database.id), dataSourceId, () => this.listUsers());
  }

  /** Walks up the page tree looking for the hub page. */
  private async isUnderHub(parent: NotionParent | undefined): Promise<boolean> {
    for (let depth = 0; parent && depth < MAX_DEPTH; depth++) {
      const id = parent.page_id ?? parent.block_id ?? parent.database_id;
      if (!id) return false; // reached the workspace root
      if (parent.type === 'page_id' && normalizeId(id) === this.hubPageId) return true;
      const path = parent.type === 'page_id' ? 'pages' : parent.type === 'block_id' ? 'blocks' : parent.type === 'database_id' ? 'databases' : null;
      if (!path) return false;
      const next: { parent?: NotionParent } = await this.request('GET', `/${path}/${id}`);
      parent = next.parent;
    }
    return false;
  }

  async listUsers() {
    if (this.users && Date.now() - this.users.at < USERS_TTL_MS) return this.users.list;
    const list: User[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({ page_size: '100', ...(cursor ? { start_cursor: cursor } : {}) });
      const res: ListResult<NotionPerson> = await this.request('GET', `/users?${params}`);
      for (const u of res.results) if (u.type === 'person') list.push(personToUser(u));
      cursor = res.has_more ? res.next_cursor : null;
    } while (cursor);
    list.sort((a, b) => a.name.localeCompare(b.name));
    this.users = { at: Date.now(), list };
    return list;
  }
}

/** One prototype's feedback database. */
export class NotionStore implements Store {
  constructor(
    private readonly request: Request,
    readonly id: string,
    private readonly dataSourceId: string,
    private readonly people: () => Promise<User[]>,
  ) {}

  private async queryAll(filter?: unknown): Promise<NotionPage[]> {
    const pages: NotionPage[] = [];
    let cursor: string | null = null;
    do {
      const res: ListResult<NotionPage> = await this.request('POST', `/data_sources/${this.dataSourceId}/query`, {
        ...(filter ? { filter } : {}),
        sorts: [{ timestamp: 'created_time', direction: 'ascending' }],
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      pages.push(...res.results);
      cursor = res.has_more ? res.next_cursor : null;
    } while (cursor);
    return pages;
  }

  private toThreads(pages: NotionPage[]): Thread[] {
    return pages.map((p) => pageToThread(p, this.id)).filter((t): t is Thread => !!t);
  }

  async listThreads(since?: string) {
    const filter = since ? { timestamp: 'last_edited_time', last_edited_time: { on_or_after: since } } : undefined;
    return this.toThreads(await this.queryAll(filter));
  }

  async getThread(remoteId: string) {
    let page: NotionPage;
    try {
      page = await this.request('GET', `/pages/${encodeURIComponent(remoteId)}`);
    } catch (err) {
      if (err instanceof NotionError && (err.status === 404 || err.status === 400)) return null;
      throw err;
    }
    // Only rows of this database: the integration can see other pages too.
    const parent = page.parent?.data_source_id;
    if (!parent || normalizeId(parent) !== normalizeId(this.dataSourceId) || page.in_trash || page.archived) return null;
    return pageToThread(page, this.id);
  }

  async findByClientId(clientId: string) {
    return this.toThreads(await this.queryAll({ property: PROPS.clientId, rich_text: { equals: clientId } }))[0] ?? null;
  }

  async createThread({ clientId, page, url, pin, body, mentions, author }: NewThreadInput) {
    const created: NotionPage = await this.request('POST', '/pages', {
      parent: { type: 'data_source_id', data_source_id: this.dataSourceId },
      properties: {
        [PROPS.title]: { title: textChunks(body.slice(0, TEXT_LIMIT)) },
        [PROPS.page]: { rich_text: textChunks(page) },
        [PROPS.link]: { url: url || null },
        [PROPS.status]: { select: { name: STATUS_NAMES.open } },
        [PROPS.reviewer]: { people: [{ id: author.id }] },
        [PROPS.mentioned]: { people: mentions.map((m) => ({ id: m.id })) },
        [PROPS.count]: { number: 1 },
        [PROPS.pin]: { rich_text: textChunks(JSON.stringify(pin)) },
        [PROPS.clientId]: { rich_text: textChunks(clientId) },
      },
    });
    const comment = await this.postComment(created.id, body, mentions, author);
    const thread = pageToThread(created, this.id)!;
    return { ...thread, comments: [{ ...notionCommentToComment(comment, [author]), author }], commentCount: 1 };
  }

  private postComment(pageId: string, body: string, mentions: User[], author: User): Promise<NotionComment> {
    return this.request('POST', '/comments', {
      parent: { page_id: pageId },
      rich_text: toRichText(body, mentions),
      // Shows the verified reviewer's name instead of the integration's.
      display_name: { type: 'custom', custom: { name: author.name } },
    });
  }

  async setStatus(remoteId: string, status: ThreadStatus, by: User) {
    const page: NotionPage = await this.request('PATCH', `/pages/${remoteId}`, {
      properties: {
        [PROPS.status]: { select: { name: STATUS_NAMES[status] } },
        [PROPS.resolvedBy]: { people: status === 'resolved' ? [{ id: by.id }] : [] },
      },
    });
    return pageToThread(page, this.id)!;
  }

  async trashThread(remoteId: string) {
    await this.request('PATCH', `/pages/${remoteId}`, { in_trash: true });
  }

  async listComments(remoteId: string) {
    const comments: NotionComment[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({ block_id: remoteId, page_size: '100', ...(cursor ? { start_cursor: cursor } : {}) });
      const res: ListResult<NotionComment> = await this.request('GET', `/comments?${params}`);
      comments.push(...res.results);
      cursor = res.has_more ? res.next_cursor : null;
    } while (cursor);
    const people = await this.people();
    return comments.map((c) => notionCommentToComment(c, people));
  }

  async addComment(remoteId: string, { body, mentions, author }: { body: string; mentions: User[]; author: User }) {
    await this.postComment(remoteId, body, mentions, author);
    const comments = await this.listComments(remoteId);
    // Comments don't change a row's last_edited_time; updating the count does, so delta syncs see it.
    await this.request('PATCH', `/pages/${remoteId}`, { properties: { [PROPS.count]: { number: comments.length } } });
    return comments;
  }
}
