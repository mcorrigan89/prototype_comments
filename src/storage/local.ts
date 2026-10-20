import type { AdapterOptions, Comment, ExportFile, StorageAdapter, Thread, User } from '../types';
import { LOG, nowIso, uid } from '../util';

const USER_KEY = 'pc:v1:user';

/** localStorage when available, an in-memory map otherwise (private mode, blocked storage). */
export function createKeyValueStore() {
  let usable = false;
  try {
    const probe = '__pc_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    usable = true;
  } catch {
    console.warn(LOG, 'localStorage is unavailable — comments will only last until the page is closed.');
  }
  const memory = new Map<string, string>();
  return {
    persistent: usable,
    get(key: string): string | null {
      return usable ? localStorage.getItem(key) : (memory.get(key) ?? null);
    },
    set(key: string, value: string) {
      if (usable) localStorage.setItem(key, value);
      else memory.set(key, value);
    },
    remove(key: string) {
      if (usable) localStorage.removeItem(key);
      else memory.delete(key);
    },
  };
}

export function createLocalAdapter({ project, users }: AdapterOptions): StorageAdapter {
  const threadsKey = `pc:v1:${project}:threads`;
  const kv = createKeyValueStore();
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const fn of listeners) {
      try {
        fn();
      } catch (err) {
        console.error(LOG, err);
      }
    }
  };

  // Keeps other tabs of the same prototype in sync.
  window.addEventListener('storage', (e) => {
    if (e.key === threadsKey) emit();
  });

  function read(): Thread[] {
    try {
      const parsed = JSON.parse(kv.get(threadsKey) ?? '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function mutate<T>(fn: (threads: Thread[]) => T): T {
    const threads = read();
    const result = fn(threads);
    kv.set(threadsKey, JSON.stringify(threads));
    emit();
    return result;
  }

  function findThread(threads: Thread[], id: string): Thread {
    const thread = threads.find((t) => t.id === id);
    if (!thread) throw new Error(`Thread ${id} not found`);
    return thread;
  }

  async function getCurrentUser(): Promise<User | null> {
    try {
      const user = JSON.parse(kv.get(USER_KEY) ?? 'null');
      return user && typeof user.id === 'string' && typeof user.name === 'string' ? user : null;
    } catch {
      return null;
    }
  }

  return {
    name: 'local',
    label: kv.persistent ? 'Saved in this browser' : 'Not saved (storage blocked)',
    auth: 'name',

    async listThreads() {
      return read();
    },

    async createThread({ page, url, pin, body, mentions, author }) {
      const ts = nowIso();
      const thread: Thread = {
        id: uid(),
        project,
        page,
        url,
        pin,
        status: 'open',
        createdBy: author,
        createdAt: ts,
        updatedAt: ts,
        comments: [{ id: uid(), author, body, mentions, createdAt: ts }],
      };
      return mutate((threads) => {
        threads.push(thread);
        return thread;
      });
    },

    async addComment(threadId, { body, mentions, author }) {
      return mutate((threads) => {
        const thread = findThread(threads, threadId);
        const comment: Comment = { id: uid(), author, body, mentions, createdAt: nowIso() };
        thread.comments.push(comment);
        thread.updatedAt = comment.createdAt;
        return comment;
      });
    },

    async setStatus(threadId, status, by) {
      return mutate((threads) => {
        const thread = findThread(threads, threadId);
        thread.status = status;
        thread.updatedAt = nowIso();
        if (status === 'resolved') {
          thread.resolvedBy = by;
          thread.resolvedAt = thread.updatedAt;
        } else {
          delete thread.resolvedBy;
          delete thread.resolvedAt;
        }
        return thread;
      });
    },

    async deleteComment(threadId, commentId) {
      mutate((threads) => {
        const index = threads.findIndex((t) => t.id === threadId);
        if (index < 0) return;
        const thread = threads[index];
        thread.comments = thread.comments.filter((c) => c.id !== commentId);
        // A thread with no comments left has nothing to show.
        if (thread.comments.length === 0) threads.splice(index, 1);
        else thread.updatedAt = nowIso();
      });
    },

    async deleteThread(threadId) {
      mutate((threads) => {
        const index = threads.findIndex((t) => t.id === threadId);
        if (index >= 0) threads.splice(index, 1);
      });
    },

    getCurrentUser,

    async setUserName(name) {
      const previous = await getCurrentUser();
      const user: User = { id: previous?.id ?? uid(), name };
      kv.set(USER_KEY, JSON.stringify(user));
      return user;
    },

    async listUsers() {
      const byId = new Map<string, User>();
      for (const u of users) if (u?.name) byId.set(u.id ?? u.name, { ...u, id: u.id ?? u.name });
      for (const thread of read()) {
        for (const c of thread.comments) if (c.author && !byId.has(c.author.id)) byId.set(c.author.id, c.author);
      }
      return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
    },

    async exportData(): Promise<ExportFile> {
      return { format: 'prototype-comments', version: 1, project, exportedAt: nowIso(), threads: read() };
    },

    async importData(data) {
      const incoming: unknown = Array.isArray(data) ? data : (data as Partial<ExportFile> | null)?.threads;
      if (!Array.isArray(incoming)) throw new Error('No threads found in that file');
      let added = 0;
      let updated = 0;
      mutate((threads) => {
        for (const raw of incoming as Thread[]) {
          if (!raw || typeof raw.id !== 'string' || !Array.isArray(raw.comments) || !raw.pin) continue;
          const thread = { ...raw, project };
          const index = threads.findIndex((t) => t.id === thread.id);
          if (index < 0) {
            threads.push(thread);
            added++;
          } else if ((thread.updatedAt ?? '') > (threads[index].updatedAt ?? '')) {
            threads[index] = thread;
            updated++;
          }
        }
      });
      return { added, updated };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
