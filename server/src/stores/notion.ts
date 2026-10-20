import type { Comment, Pin, Thread, ThreadStatus, User } from '../../../src/types';
import { HttpError, badRequest } from '../http';
import { notionIdFrom, type NewThreadInput, type Store, type Workspace } from '../ports';

export const NOTION_API = 'https://api.notion.com/v1';
/** 2025-09-03 introduced data sources; 2026-03-11 renamed `archived` to `in_trash`. */
export const NOTION_VERSION = '2026-03-11';

/** Column names in a comments database (created by NotionWorkspace, see DATABASE_PROPERTIES). */
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

/** How a new comments database's table looks in Notion: column order and widths, then hidden columns. */
export const TABLE_LAYOUT: { name: string; width?: number; wrap?: boolean; hidden?: boolean }[] = [
  { name: PROPS.title, width: 360, wrap: true },
  { name: PROPS.status, width: 110 },
  { name: PROPS.reviewer, width: 170 },
  { name: PROPS.page, width: 140 },
  { name: PROPS.count, width: 90 },
  { name: PROPS.mentioned, width: 170 },
  { name: PROPS.resolvedBy, width: 170 },
  { name: PROPS.link, width: 200 },
  // Machine data: the overlay needs these, people reading Notion don't.
  { name: PROPS.pin, hidden: true },
  { name: PROPS.clientId, hidden: true },
];

/** Column definitions used when creating a comments database. Must satisfy SCHEMA. */
export const DATABASE_PROPERTIES = {
  [PROPS.title]: { title: {} },
  [PROPS.status]: {
    select: {
      options: [
        { name: STATUS_NAMES.open, color: 'yellow' },
        { name: STATUS_NAMES.resolved, color: 'green' },
      ],
    },
  },
  [PROPS.reviewer]: { people: {} },
  [PROPS.mentioned]: { people: {} },
  [PROPS.resolvedBy]: { people: {} },
  [PROPS.page]: { rich_text: {} },
  [PROPS.link]: { url: {} },
  [PROPS.count]: { number: { format: 'number' } },
  [PROPS.pin]: { rich_text: {} },
  [PROPS.clientId]: { rich_text: {} },
};

const TEXT_LIMIT = 2000; // per rich-text object
const RICH_TEXT_ITEMS = 100; // per array
const USERS_TTL_MS = 10 * 60 * 1000;
/** How long a resolved data-notion link is reused before it's checked again. */
const DATABASE_TTL_MS = 10 * 60 * 1000;
/** A page with no comments database yet is re-checked sooner, so new comments show up. */
const EMPTY_TTL_MS = 30 * 1000;
/** Title of the database the backend creates inside a prototype's page. */
export const DATABASE_TITLE = 'Comments';

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

interface NotionDatabase {
  id: string;
  in_trash?: boolean;
  data_sources?: { id: string }[];
}

export interface NotionWorkspaceOptions {
  token: string;
  fetch?: Fetch;
}

/**
 * Resolves data-notion links. A link can be:
 *
 * - a regular page (the usual case): its comments live in a "Comments" database
 *   inside it, which is created on the first comment;
 * - a comments database directly.
 *
 * The integration only sees pages someone deliberately connected to it
 * (••• → Connections), and the backend only ever writes rows to a database with
 * the comment columns, so a script tag can't point it at anything else.
 */
export class NotionWorkspace implements Workspace {
  private readonly request: Request;
  private readonly resolved = new Map<string, { at: number; ttl: number; store: Promise<Store> }>();
  private users: { at: number; list: User[] } | null = null;

  constructor({ token, fetch: fetchImpl }: NotionWorkspaceOptions) {
    this.request = notionRequest(token, fetchImpl);
  }

  open(ref: string, { create = false } = {}): Promise<Store> {
    const id = notionIdFrom(ref);
    if (!id) return Promise.reject(badRequest('data-notion should be a Notion page link'));
    const cached = this.resolved.get(id);
    if (cached && Date.now() - cached.at < cached.ttl) {
      // A cached "no comments yet" can't take a write: look again, creating if needed.
      return create ? cached.store.then((s) => (s instanceof EmptyStore ? this.resolve(id, true) : s)) : cached.store;
    }
    return this.resolve(id, create);
  }

  private resolve(id: string, create: boolean): Promise<Store> {
    const store = this.find(id, create);
    const entry = { at: Date.now(), ttl: DATABASE_TTL_MS, store };
    this.resolved.set(id, entry);
    store.then(
      (s) => {
        if (s instanceof EmptyStore) entry.ttl = EMPTY_TTL_MS;
      },
      () => this.resolved.delete(id), // don't remember failures
    );
    return store;
  }

  private async find(id: string, create: boolean): Promise<Store> {
    const cantSee = () =>
      new HttpError(404, 'The backend can’t see that Notion page. In Notion, open it and use ••• → Connections to add the integration.', 'not_found');

    // A link straight to a comments database.
    const database = await this.tryGet<NotionDatabase>(`/databases/${id}`);
    if (database) {
      if (database.in_trash) throw cantSee();
      const store = await this.storeFor(id, database);
      if (!store) throw badRequest(`That Notion database doesn’t have the comment columns. Link the prototype’s page instead, and the backend will set one up.`);
      return store;
    }

    // A regular page: find (or create) the comments database inside it.
    const page = await this.tryGet<{ in_trash?: boolean; archived?: boolean }>(`/pages/${id}`);
    if (!page || page.in_trash || page.archived) throw cantSee();
    for (const childId of await this.childDatabases(id)) {
      const child = await this.tryGet<NotionDatabase>(`/databases/${childId}`);
      const store = child && !child.in_trash ? await this.storeFor(id, child) : null;
      if (store) return store;
    }
    if (!create) return new EmptyStore(id);

    const created: NotionDatabase = await this.request('POST', '/databases', {
      parent: { type: 'page_id', page_id: id },
      title: [{ type: 'text', text: { content: DATABASE_TITLE } }],
      icon: { type: 'emoji', emoji: '💬' },
      // Shown as a table right on the prototype's page, not as a link to a separate page.
      is_inline: true,
      initial_data_source: { properties: DATABASE_PROPERTIES },
    });
    const store = await this.storeFor(id, created);
    if (!store) throw new Error('Created a comments database but it doesn’t match the expected columns');
    await this.arrangeTable(created).catch((err) => console.warn('Couldn’t arrange the comments table (cosmetic only):', err));
    return store;
  }

  /** Orders, sizes and hides columns in the new database's default view. */
  private async arrangeTable(database: NotionDatabase) {
    const dataSourceId = database.data_sources![0].id;
    const source: { properties: Record<string, { id: string }> } = await this.request('GET', `/data_sources/${dataSourceId}`);
    const views: ListResult<{ id: string }> = await this.request('GET', `/views?${new URLSearchParams({ database_id: database.id })}`);
    const view = views.results[0];
    if (!view) return;
    const properties = TABLE_LAYOUT.filter((col) => source.properties[col.name]).map((col) => ({
      property_id: source.properties[col.name].id,
      visible: !col.hidden,
      ...(col.width ? { width: col.width } : {}),
      ...(col.wrap ? { wrap: true } : {}),
    }));
    await this.request('PATCH', `/views/${view.id}`, { name: 'All comments', configuration: { type: 'table', properties } });
  }

  /** A store for this database if it has the comment columns, else null. */
  private async storeFor(id: string, database: NotionDatabase): Promise<NotionStore | null> {
    const dataSourceId = database.data_sources?.[0]?.id;
    if (!dataSourceId) return null;
    const source: { properties: Record<string, { type: string }> } = await this.request('GET', `/data_sources/${dataSourceId}`);
    const matches = Object.entries(SCHEMA).every(([name, type]) => source.properties[name]?.type === type);
    return matches ? new NotionStore(this.request, id, dataSourceId, () => this.listUsers()) : null;
  }

  private async childDatabases(pageId: string): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({ page_size: '100', ...(cursor ? { start_cursor: cursor } : {}) });
      const res: ListResult<{ id: string; type: string }> = await this.request('GET', `/blocks/${pageId}/children?${params}`);
      for (const block of res.results) if (block.type === 'child_database') ids.push(block.id);
      cursor = res.has_more ? res.next_cursor : null;
    } while (cursor);
    return ids;
  }

  /** GET that treats "not found / no access" as null. */
  private async tryGet<T>(path: string): Promise<T | null> {
    try {
      return await this.request<T>('GET', path);
    } catch (err) {
      if (err instanceof NotionError && (err.status === 404 || err.status === 400)) return null;
      throw err;
    }
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

/** A prototype page that has no comments yet. Reads are empty; writes go through open(…, { create: true }). */
class EmptyStore implements Store {
  constructor(readonly id: string) {}
  async listThreads() {
    return [];
  }
  async getThread() {
    return null;
  }
  async findByClientId() {
    return null;
  }
  private nothingHere(): never {
    throw new HttpError(404, 'That thread no longer exists', 'not_found');
  }
  createThread = async (): Promise<Thread> => this.nothingHere();
  setStatus = async (): Promise<Thread> => this.nothingHere();
  trashThread = async (): Promise<void> => this.nothingHere();
  listComments = async (): Promise<Comment[]> => this.nothingHere();
  addComment = async (): Promise<Comment[]> => this.nothingHere();
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
