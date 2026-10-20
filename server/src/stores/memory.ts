import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Comment, Thread, User } from '../../../src/types';
import { badRequest } from '../http';
import { notionIdFrom, type NewThreadInput, type Store, type Workspace } from '../ports';

interface Row {
  thread: Thread;
  trashed?: boolean;
}

export const FAKE_USERS: User[] = [
  { id: 'fake-ana', name: 'Ana Ruiz', email: 'ana@example.com' },
  { id: 'fake-ben', name: 'Ben Okafor', email: 'ben@example.com' },
  { id: 'fake-chloe', name: 'Chloe Park', email: 'chloe@example.com' },
  { id: 'fake-dev', name: 'Dev Patel', email: 'dev@example.com' },
];

/** Fake mode accepts real Notion links (using their id) or any short slug like "demo-shop". */
const SLUG_RE = /^[\w-]{1,64}$/;

/** Mirrors what NotionStore returns from list queries: just the first comment plus a count. */
function summary(thread: Thread): Thread {
  return { ...thread, comments: thread.comments.slice(0, 1), commentCount: thread.comments.length };
}

/**
 * Stand-in for Notion during development and tests. Every database lives in one
 * list of rows (tagged by thread.project), optionally persisted to a JSON file so
 * local data survives restarts.
 */
export class MemoryWorkspace implements Workspace {
  private rows: Row[] = [];

  constructor(
    private readonly users: User[] = FAKE_USERS,
    private readonly file?: string,
  ) {
    if (file) {
      try {
        this.rows = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        this.rows = [];
      }
    }
  }

  async open(ref: string): Promise<Store> {
    const id = notionIdFrom(ref) ?? (SLUG_RE.test(ref) ? ref : null);
    if (!id) throw badRequest('data-notion should be a Notion page link');
    return new MemoryStore(id, this.rows, () => this.save());
  }

  async listUsers() {
    return this.users;
  }

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.rows, null, 2));
  }
}

class MemoryStore implements Store {
  constructor(
    readonly id: string,
    private readonly rows: Row[],
    private readonly save: () => void,
  ) {}

  private live(): Row[] {
    return this.rows.filter((r) => !r.trashed && r.thread.project === this.id);
  }

  private row(remoteId: string): Row | undefined {
    return this.live().find((r) => r.thread.remoteId === remoteId);
  }

  private touch(row: Row) {
    // Strictly increasing, so delta syncs in tests see every change.
    const last = Date.parse(row.thread.updatedAt);
    row.thread.updatedAt = new Date(Math.max(Date.now(), last + 1)).toISOString();
  }

  async listThreads(since?: string) {
    return this.live()
      .filter((r) => !since || r.thread.updatedAt >= since)
      .map((r) => summary(r.thread));
  }

  async getThread(remoteId: string) {
    const row = this.row(remoteId);
    return row ? summary(row.thread) : null;
  }

  async findByClientId(clientId: string) {
    const row = this.live().find((r) => r.thread.id === clientId);
    return row ? summary(row.thread) : null;
  }

  async createThread({ clientId, page, url, pin, body, mentions, author }: NewThreadInput) {
    const now = new Date().toISOString();
    const thread: Thread = {
      id: clientId,
      remoteId: `mem_${randomUUID()}`,
      project: this.id,
      page,
      url,
      pin,
      status: 'open',
      createdBy: author,
      createdAt: now,
      updatedAt: now,
      comments: [{ id: randomUUID(), author, body, mentions, createdAt: now }],
    };
    this.rows.push({ thread });
    this.save();
    return summary(thread);
  }

  async setStatus(remoteId: string, status: Thread['status'], by: User) {
    const row = this.row(remoteId);
    if (!row) throw Object.assign(new Error('Not found'), { status: 404 });
    row.thread.status = status;
    if (status === 'resolved') row.thread.resolvedBy = by;
    else delete row.thread.resolvedBy;
    this.touch(row);
    this.save();
    return summary(row.thread);
  }

  async trashThread(remoteId: string) {
    const row = this.row(remoteId);
    if (row) row.trashed = true;
    this.save();
  }

  async listComments(remoteId: string): Promise<Comment[]> {
    return structuredClone(this.row(remoteId)?.thread.comments ?? []);
  }

  async addComment(remoteId: string, { body, mentions, author }: { body: string; mentions: User[]; author: User }) {
    const row = this.row(remoteId);
    if (!row) throw Object.assign(new Error('Not found'), { status: 404 });
    row.thread.comments.push({ id: randomUUID(), author, body, mentions, createdAt: new Date().toISOString() });
    this.touch(row);
    this.save();
    return structuredClone(row.thread.comments);
  }
}
