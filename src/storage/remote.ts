import {
  AUTH_HASH,
  userFromClaims,
  type CommentsResponse,
  type CreateThreadBody,
  type ErrorResponse,
  type SessionClaims,
  type SyncResponse,
  type UsersResponse,
} from '../api';
import type { AdapterOptions, Comment, ExportFile, StorageAdapter, Thread, ThreadStatus, User } from '../types';
import { LOG, nowIso, timeAgo, uid } from '../util';
import { createKeyValueStore } from './local';

/**
 * Talks to the backend (server/), keeping a local copy so the overlay never waits on the network:
 *
 * - Reads come from the local copy, refreshed by a background sync that asks only for
 *   threads changed since the last one (plus a periodic full sync to notice deletions).
 * - Writes apply to the local copy immediately and queue in an outbox, which is sent in
 *   order, retried with backoff, and survives reloads. Rejected writes are marked failed.
 */

const SYNC_INTERVAL_MS = 20_000;
const FULL_SYNC_EVERY_MS = 5 * 60_000;
const USERS_TTL_MS = 10 * 60_000;
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const LOCK_TTL_MS = 15_000;
const MAX_BACKOFF_MS = 60_000;

type Op =
  | { kind: 'createThread'; threadId: string; body: CreateThreadBody }
  | { kind: 'addComment'; threadId: string; commentId: string; body: string; mentions: User[] }
  | { kind: 'setStatus'; threadId: string; status: ThreadStatus }
  | { kind: 'deleteThread'; threadId: string; remoteId: string };

type QueuedOp = Op & { opId: string; attempts: number; nextAt: number; failed?: string };

interface Cache {
  threads: Thread[];
  /** serverTime of the last successful sync, sent back as `since`. */
  lastSync?: string;
  /** When the last full sync happened (ms). */
  lastFull?: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

function decodeClaims(token: string | null): SessionClaims | null {
  if (!token) return null;
  try {
    const b64 = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes)) as SessionClaims;
    return claims.exp * 1000 > Date.now() ? claims : null;
  } catch {
    return null;
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export interface RemoteAdapter extends StorageAdapter {
  /** Sends queued changes now. Exposed for tests. */
  flushNow(): Promise<void>;
  /** Syncs now. Exposed for tests. */
  syncNow(full?: boolean): Promise<void>;
  /** Stops background timers. */
  stop(): void;
}

export function createRemoteAdapter({ project, endpoint, notion }: AdapterOptions): RemoteAdapter {
  if (!endpoint) throw new Error('data-endpoint is required with data-storage="remote"');
  if (!notion) throw new Error('data-notion is required with data-storage="remote": the prototype’s Notion feedback database');
  const base = endpoint.replace(/\/$/, '');
  /** Appended to every thread route: which feedback database this prototype uses. */
  const db = (path: string) => `${path}${path.includes('?') ? '&' : '?'}${new URLSearchParams({ db: notion })}`;
  const host = new URL(base, location.href).host;
  const keys = {
    session: `pc:v2:${host}:session`,
    users: `pc:v2:${host}:users`,
    cache: `pc:v2:${host}:${project}:cache`,
    outbox: `pc:v2:${host}:${project}:outbox`,
    lock: `pc:v2:${host}:${project}:lock`,
  };
  const kv = createKeyValueStore();
  const tabId = uid();
  const listeners = new Set<() => void>();
  const notices: string[] = [];

  const status = { online: true, lastSyncAt: 0, readError: '' };
  let flushing: Promise<void> | null = null;
  let syncing: Promise<void> | null = null;
  let retryTimer = 0;
  let interval = 0;
  let pendingSignIn: ((user: User | null) => void) | null = null;

  const emit = () => {
    for (const fn of listeners) {
      try {
        fn();
      } catch (err) {
        console.error(LOG, err);
      }
    }
  };

  // ---------- persisted state (always re-read: other tabs may have changed it) ----------

  function readJson<T>(key: string, fallback: T): T {
    try {
      return (JSON.parse(kv.get(key) ?? 'null') as T) ?? fallback;
    } catch {
      return fallback;
    }
  }
  const readCache = () => readJson<Cache>(keys.cache, { threads: [] });
  const readOutbox = () => readJson<QueuedOp[]>(keys.outbox, []);
  const writeOutbox = (ops: QueuedOp[]) => kv.set(keys.outbox, JSON.stringify(ops));

  function mutateCache<T>(fn: (cache: Cache) => T): T {
    const cache = readCache();
    const result = fn(cache);
    kv.set(keys.cache, JSON.stringify(cache));
    return result;
  }

  function mutateThread(threadId: string, fn: (thread: Thread) => void) {
    mutateCache((cache) => {
      const thread = cache.threads.find((t) => t.id === threadId);
      if (thread) fn(thread);
    });
  }

  function enqueue(op: Op) {
    writeOutbox([...readOutbox(), { ...op, opId: uid(), attempts: 0, nextAt: 0 }]);
  }

  // ---------- session ----------

  const sessionToken = () => (decodeClaims(kv.get(keys.session)) ? kv.get(keys.session) : null);

  function currentUser(): User | null {
    const claims = decodeClaims(kv.get(keys.session));
    return claims ? userFromClaims(claims) : null;
  }

  /** Picks up the token the backend put in the URL hash after sign-in. */
  function consumeAuthRedirect() {
    const params = new URLSearchParams(location.hash.slice(1));
    const token = params.get(AUTH_HASH.token);
    const error = params.get(AUTH_HASH.error);
    if (!token && !error) return;

    const original = params.get(AUTH_HASH.returnHash);
    history.replaceState(history.state, '', `${location.pathname}${location.search}${original ? `#${original}` : ''}`);

    if (token && decodeClaims(token)) {
      kv.set(keys.session, token);
      notices.push(`Signed in as ${currentUser()?.name}`);
    } else {
      notices.push(error || 'Sign-in failed');
    }
    if (params.has(AUTH_HASH.popup)) {
      // The tab that opened us notices the new session through the storage event.
      window.close();
      notices.push('You’re signed in. You can close this window.');
    }
  }

  // ---------- HTTP ----------

  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = sessionToken();
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ApiError(0, 'Offline');
    }
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => ({}))) as Partial<ErrorResponse>;
    if (!res.ok) {
      if (res.status === 401 && token) {
        // Expired or revoked: forget it so the overlay asks to sign in again.
        kv.remove(keys.session);
        notices.push('Your sign-in expired. Sign in again to keep commenting.');
      }
      throw new ApiError(res.status, data.error ?? res.statusText, data.code);
    }
    return data as T;
  }

  // ---------- sync ----------

  /** Threads with unsent changes: the local version wins until they're delivered. */
  const busyThreadIds = () => new Set(readOutbox().map((op) => op.threadId));

  function mergeThread(local: Thread | undefined, server: Thread): Thread {
    const total = server.commentCount ?? server.comments.length;
    const sent = local?.comments.filter((c) => !c.delivery) ?? [];
    const unsent = local?.comments.filter((c) => c.delivery) ?? [];
    // Keep fully-loaded comments while the count still matches; otherwise take the summary
    // and let loadComments() fetch the rest when the thread is opened.
    const comments = sent.length > 0 && sent.length === total ? sent : server.comments;
    return { ...server, comments: [...comments, ...unsent] };
  }

  async function sync(forceFull = false) {
    const cache = readCache();
    const full = forceFull || !cache.lastSync || Date.now() - (cache.lastFull ?? 0) > FULL_SYNC_EVERY_MS;
    const params = new URLSearchParams();
    if (!full) params.set('since', cache.lastSync!);
    try {
      const res = await api<SyncResponse>('GET', db(`/threads?${params}`));
      const busy = busyThreadIds();
      mutateCache((c) => {
        const byId = new Map(c.threads.map((t) => [t.id, t]));
        const seen = new Set<string>();
        for (const server of res.threads) {
          seen.add(server.id);
          if (busy.has(server.id)) continue;
          byId.set(server.id, mergeThread(byId.get(server.id), server));
        }
        if (res.full) for (const id of byId.keys()) if (!seen.has(id) && !busy.has(id)) byId.delete(id);
        c.threads = [...byId.values()];
        c.lastSync = res.serverTime;
        if (res.full) c.lastFull = Date.now();
      });
      status.online = true;
      status.readError = '';
      status.lastSyncAt = Date.now();
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (err.status === 0) status.online = false;
      // 4xx: something the user can fix (sign in, connect the page), so show it in the sidebar.
      else if (err.status >= 400 && err.status < 500) status.readError = err.message;
      else console.warn(LOG, 'sync failed:', err.message);
    }
    emit();
  }

  // ---------- outbox ----------

  /** A lease in localStorage so two tabs don't send the same queue twice. */
  function acquireLock(): boolean {
    const lock = readJson<{ owner: string; until: number } | null>(keys.lock, null);
    if (lock && lock.owner !== tabId && lock.until > Date.now()) return false;
    kv.set(keys.lock, JSON.stringify({ owner: tabId, until: Date.now() + LOCK_TTL_MS }));
    return readJson<{ owner: string } | null>(keys.lock, null)?.owner === tabId;
  }
  function releaseLock() {
    if (readJson<{ owner: string } | null>(keys.lock, null)?.owner === tabId) kv.remove(keys.lock);
  }

  function updateOp(opId: string, fn: (op: QueuedOp) => QueuedOp | null) {
    writeOutbox(readOutbox().flatMap((op) => (op.opId === opId ? (fn(op) ?? []) : [op])));
  }

  /** The first op that can go now: not failed, and not behind a failed op for the same thread. */
  function nextOp(): QueuedOp | undefined {
    const blocked = new Set<string>();
    for (const op of readOutbox()) {
      if (op.failed) blocked.add(op.threadId);
      else if (!blocked.has(op.threadId)) return op;
    }
    return undefined;
  }

  function setDelivery(threadId: string, commentId: string | null, delivery: Comment['delivery'], error?: string) {
    mutateThread(threadId, (t) => {
      const comment = commentId ? t.comments.find((c) => c.id === commentId) : t.comments[0];
      if (!comment) return;
      comment.delivery = delivery;
      if (error) comment.error = error;
      else delete comment.error;
    });
  }

  async function send(op: QueuedOp) {
    switch (op.kind) {
      case 'createThread': {
        const created = await api<Thread>('POST', db('/threads'), op.body);
        mutateThread(op.threadId, (t) => {
          const firstLocal = t.comments[0]?.id;
          const unsent = t.comments.filter((c) => c.delivery && c.id !== firstLocal);
          Object.assign(t, created, { comments: [...created.comments, ...unsent] });
        });
        return;
      }
      case 'addComment': {
        const thread = readCache().threads.find((t) => t.id === op.threadId);
        if (!thread?.remoteId) return; // thread is gone
        const res = await api<CommentsResponse>('POST', db(`/threads/${thread.remoteId}/comments`), {
          body: op.body,
          mentions: op.mentions,
          retry: op.attempts > 0,
        });
        mutateThread(op.threadId, (t) => {
          const unsent = t.comments.filter((c) => c.delivery && c.id !== op.commentId);
          t.comments = [...res.comments, ...unsent];
          t.commentCount = res.comments.length;
        });
        return;
      }
      case 'setStatus': {
        const thread = readCache().threads.find((t) => t.id === op.threadId);
        if (!thread?.remoteId) return;
        const updated = await api<Thread>('PATCH', db(`/threads/${thread.remoteId}`), { status: op.status });
        mutateThread(op.threadId, (t) => Object.assign(t, updated, { comments: t.comments }));
        return;
      }
      case 'deleteThread':
        try {
          await api<void>('DELETE', db(`/threads/${op.remoteId}`));
        } catch (err) {
          if (!(err instanceof ApiError && err.status === 404)) throw err;
        }
        return;
    }
  }

  function onRejected(op: QueuedOp, message: string) {
    if (op.kind === 'createThread' || op.kind === 'addComment') {
      // Keep it so the user can retry; show it as not sent.
      updateOp(op.opId, (o) => ({ ...o, failed: message }));
      setDelivery(op.threadId, op.kind === 'addComment' ? op.commentId : null, 'failed', message);
    } else {
      // Status changes and deletes: drop it and let a full sync restore the real state.
      updateOp(op.opId, () => null);
      notices.push(`Couldn’t ${op.kind === 'setStatus' ? 'update' : 'delete'} the thread: ${message}`);
      void sync(true);
    }
  }

  function scheduleRetry(at: number) {
    clearTimeout(retryTimer);
    retryTimer = window.setTimeout(() => void flush(), Math.max(0, at - Date.now()));
  }

  async function flushQueue() {
    if (!readOutbox().length || !sessionToken() || !acquireLock()) return;
    try {
      for (let op = nextOp(); op; op = nextOp()) {
        if (op.nextAt > Date.now()) {
          scheduleRetry(op.nextAt);
          break;
        }
        try {
          await send(op);
          updateOp(op.opId, () => null);
          status.online = true;
        } catch (err) {
          if (!(err instanceof ApiError)) throw err;
          if (err.status === 401) break; // wait for sign-in; the op stays queued
          if (err.status === 0 || err.status === 429 || err.status >= 500) {
            if (err.status === 0) status.online = false;
            const attempts = op.attempts + 1;
            const nextAt = Date.now() + Math.min(MAX_BACKOFF_MS, 2000 * 2 ** (attempts - 1));
            updateOp(op.opId, (o) => ({ ...o, attempts, nextAt }));
            scheduleRetry(nextAt);
            break;
          }
          onRejected(op, err.message);
        }
        emit();
        acquireLock(); // renew the lease
      }
    } finally {
      releaseLock();
      emit();
    }
  }

  function flush(): Promise<void> {
    flushing ??= flushQueue().finally(() => (flushing = null));
    return flushing;
  }

  function syncOnce(full = false): Promise<void> {
    syncing ??= sync(full).finally(() => (syncing = null));
    return syncing;
  }

  const tick = () => {
    if (document.visibilityState === 'hidden') return;
    void flush().then(() => syncOnce());
  };

  let started = false;
  function start() {
    if (started) return;
    started = true;
    interval = window.setInterval(tick, SYNC_INTERVAL_MS);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('online', tick);
    window.addEventListener('storage', (e) => {
      if (e.key === keys.session) {
        const user = currentUser();
        if (user && pendingSignIn) pendingSignIn(user);
        if (user) tick();
        emit();
      } else if (e.key === keys.cache || e.key === keys.outbox) {
        emit();
      }
    });
    tick();
  }

  consumeAuthRedirect();

  // ---------- adapter ----------

  return {
    name: 'remote',
    auth: 'signin',

    get label() {
      const ops = readOutbox();
      const failed = ops.filter((o) => o.failed).length;
      const pending = ops.length - failed;
      if (failed) return `${plural(failed, 'change')} not sent`;
      if (!status.online) return pending ? `Offline · ${pending} waiting to send` : 'Offline · showing saved copy';
      if (pending) return sessionToken() ? `Sending ${plural(pending, 'change')}…` : `Sign in to send ${plural(pending, 'change')}`;
      if (status.readError) return status.readError;
      if (!status.lastSyncAt) return 'Connecting…';
      return `Synced ${timeAgo(new Date(status.lastSyncAt).toISOString())}`;
    },

    async listThreads() {
      return readCache().threads;
    },

    async createThread({ page, url, pin, body, mentions, author }) {
      const ts = nowIso();
      const id = uid();
      const thread: Thread = {
        id,
        project,
        page,
        url,
        pin,
        status: 'open',
        createdBy: author,
        createdAt: ts,
        updatedAt: ts,
        comments: [{ id: uid(), author, body, mentions, createdAt: ts, delivery: 'pending' }],
        commentCount: 1,
      };
      mutateCache((c) => c.threads.push(thread));
      enqueue({ kind: 'createThread', threadId: id, body: { clientId: id, page, url, pin, body, mentions } });
      emit();
      void flush();
      return thread;
    },

    async addComment(threadId, { body, mentions, author }) {
      const comment: Comment = { id: uid(), author, body, mentions, createdAt: nowIso(), delivery: 'pending' };
      mutateThread(threadId, (t) => {
        t.comments.push(comment);
        t.commentCount = Math.max(t.commentCount ?? 0, t.comments.length);
      });
      enqueue({ kind: 'addComment', threadId, commentId: comment.id, body, mentions });
      emit();
      void flush();
      return comment;
    },

    async setStatus(threadId, next, by) {
      let result: Thread | undefined;
      mutateThread(threadId, (t) => {
        t.status = next;
        if (next === 'resolved') t.resolvedBy = by;
        else delete t.resolvedBy;
        result = t;
      });
      if (!result) throw new Error('Thread not found');
      // Only the latest status matters.
      writeOutbox(readOutbox().filter((op) => !(op.kind === 'setStatus' && op.threadId === threadId && !op.failed)));
      enqueue({ kind: 'setStatus', threadId, status: next });
      emit();
      void flush();
      return result;
    },

    async deleteThread(threadId) {
      const thread = readCache().threads.find((t) => t.id === threadId);
      mutateCache((c) => {
        c.threads = c.threads.filter((t) => t.id !== threadId);
      });
      // Anything not yet sent for this thread is moot.
      writeOutbox(readOutbox().filter((op) => op.threadId !== threadId));
      if (thread?.remoteId) enqueue({ kind: 'deleteThread', threadId, remoteId: thread.remoteId });
      emit();
      void flush();
    },

    canDeleteComment(comment) {
      // Notion can't delete comments through its API, so only unsent ones can be discarded.
      return !!comment.delivery;
    },

    async deleteComment(threadId, commentId) {
      const thread = readCache().threads.find((t) => t.id === threadId);
      const comment = thread?.comments.find((c) => c.id === commentId);
      if (!thread || !comment) return;
      if (!comment.delivery) throw new Error('Sent comments can’t be deleted');
      if (!thread.remoteId && thread.comments[0]?.id === commentId) return this.deleteThread(threadId);
      writeOutbox(readOutbox().filter((op) => !(op.kind === 'addComment' && op.commentId === commentId)));
      mutateThread(threadId, (t) => {
        t.comments = t.comments.filter((c) => c.id !== commentId);
      });
      emit();
    },

    async loadComments(threadId) {
      const thread = readCache().threads.find((t) => t.id === threadId);
      if (!thread?.remoteId) return;
      try {
        const res = await api<CommentsResponse>('GET', db(`/threads/${thread.remoteId}/comments`));
        mutateThread(threadId, (t) => {
          t.comments = [...res.comments, ...t.comments.filter((c) => c.delivery)];
          t.commentCount = res.comments.length;
        });
        emit();
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        if (err.status === 404) void syncOnce(true);
      }
    },

    async retryFailed() {
      const ops = readOutbox();
      for (const op of ops) {
        if (!op.failed) continue;
        delete op.failed;
        op.attempts = 0;
        op.nextAt = 0;
        if (op.kind === 'createThread' || op.kind === 'addComment') {
          setDelivery(op.threadId, op.kind === 'addComment' ? op.commentId : null, 'pending');
        }
      }
      writeOutbox(ops);
      emit();
      await flush();
    },

    async getCurrentUser() {
      return currentUser();
    },

    signIn() {
      const params = new URLSearchParams({ return: location.href, popup: '1' });
      const popup = window.open(`${base}/auth/start?${params}`, 'pc-auth', 'popup,width=520,height=720');
      if (!popup) {
        // Popup blocked: sign in in this tab instead; we'll come back to this page.
        params.delete('popup');
        location.href = `${base}/auth/start?${params}`;
        return new Promise<User | null>(() => {});
      }
      pendingSignIn?.(null);
      return new Promise<User | null>((resolve) => {
        const timer = window.setTimeout(() => done(null), SIGN_IN_TIMEOUT_MS);
        const done = (user: User | null) => {
          clearTimeout(timer);
          pendingSignIn = null;
          resolve(user);
        };
        pendingSignIn = done;
      });
    },

    cancelSignIn() {
      pendingSignIn?.(null);
    },

    async signOut() {
      kv.remove(keys.session);
      kv.remove(keys.users);
      emit();
    },

    async listUsers() {
      const known = new Map<string, User>();
      for (const t of readCache().threads) for (const c of t.comments) known.set(c.author.id, c.author);
      if (sessionToken()) {
        let cached = readJson<{ at: number; users: User[] } | null>(keys.users, null);
        if (!cached || Date.now() - cached.at > USERS_TTL_MS) {
          try {
            const res = await api<UsersResponse>('GET', '/users');
            cached = { at: Date.now(), users: res.users };
            kv.set(keys.users, JSON.stringify(cached));
          } catch {
            // Fall back to whatever we had.
          }
        }
        for (const u of cached?.users ?? []) known.set(u.id, u);
      }
      return [...known.values()].sort((a, b) => a.name.localeCompare(b.name));
    },

    takeNotice() {
      return notices.shift() ?? null;
    },

    async exportData(): Promise<ExportFile> {
      return { format: 'prototype-comments', version: 1, project, exportedAt: nowIso(), threads: readCache().threads };
    },

    subscribe(listener) {
      listeners.add(listener);
      start();
      return () => listeners.delete(listener);
    },

    flushNow: flush,
    syncNow: (full = false) => syncOnce(full),
    stop() {
      clearInterval(interval);
      clearTimeout(retryTimer);
    },
  };
}
