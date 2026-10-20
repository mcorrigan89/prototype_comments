import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalAdapter } from '../src/storage/local';
import type { Pin, User } from '../src/types';

const pin: Pin = { selector: 'body', tag: 'body', text: '', offset: { x: 0.5, y: 0.5 }, page: { x: 10, y: 20 }, viewport: { w: 1200, h: 800 } };
const ana: User = { id: 'u-ana', name: 'Ana Ruiz' };

beforeEach(() => localStorage.clear());

const make = (project = 'p1') => createLocalAdapter({ project, users: [ana] });

describe('local adapter', () => {
  it('creates threads, replies, resolves and persists across instances', async () => {
    const a = make();
    const me = await a.setUserName!('Michael');
    const t = await a.createThread({ page: '/', url: 'http://x/', pin, body: 'Hi @Ana Ruiz', mentions: [ana], author: me });
    await a.addComment(t.id, { body: 'Reply', mentions: [], author: me });
    await a.setStatus(t.id, 'resolved', me);

    const [saved] = await make().listThreads();
    expect(saved.comments.map((c) => c.body)).toEqual(['Hi @Ana Ruiz', 'Reply']);
    expect(saved.status).toBe('resolved');
    expect(saved.resolvedBy?.name).toBe('Michael');
    expect(await make().getCurrentUser()).toEqual(me);
  });

  it('keeps projects separate', async () => {
    const me = await make().setUserName!('Michael');
    await make('p1').createThread({ page: '/', url: '', pin, body: 'x', mentions: [], author: me });
    expect(await make('p2').listThreads()).toHaveLength(0);
  });

  it('deletes the thread when its last comment is deleted', async () => {
    const a = make();
    const me = await a.setUserName!('Michael');
    const t = await a.createThread({ page: '/', url: '', pin, body: 'x', mentions: [], author: me });
    await a.deleteComment(t.id, t.comments[0].id);
    expect(await a.listThreads()).toHaveLength(0);
  });

  it('keeps the user id when the name changes', async () => {
    const a = make();
    const first = await a.setUserName!('Mike');
    const second = await a.setUserName!('Michael');
    expect(second).toEqual({ id: first.id, name: 'Michael' });
  });

  it('lists configured people plus anyone who has commented', async () => {
    const a = make();
    const me = await a.setUserName!('Michael');
    await a.createThread({ page: '/', url: '', pin, body: 'x', mentions: [], author: me });
    expect((await a.listUsers()).map((u) => u.name)).toEqual(['Ana Ruiz', 'Michael']);
  });

  it('round-trips export and import, merging by id', async () => {
    const a = make();
    const me = await a.setUserName!('Michael');
    await a.createThread({ page: '/', url: '', pin, body: 'x', mentions: [], author: me });
    const file = await a.exportData!();

    const b = make('other');
    expect(await b.importData!(file)).toEqual({ added: 1, updated: 0 });
    expect(await b.importData!(file)).toEqual({ added: 0, updated: 0 });
    const [imported] = await b.listThreads();
    expect(imported.project).toBe('other');
    await expect(b.importData!({ nope: true })).rejects.toThrow('No threads');
  });

  it('notifies subscribers on change', async () => {
    const a = make();
    const listener = vi.fn();
    a.subscribe(listener);
    const me = await a.setUserName!('Michael');
    await a.createThread({ page: '/', url: '', pin, body: 'x', mentions: [], author: me });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
