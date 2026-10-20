import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_HASH } from '../src/api';
import { createRemoteAdapter, type RemoteAdapter } from '../src/storage/remote';
import type { User } from '../src/types';
import { API, body, handlerFetch, pin, setup } from './server/helpers';

let offline = false;
let server: ReturnType<typeof setup>;
let adapters: RemoteAdapter[] = [];

const ana: User = { id: 'fake-ana', name: 'Ana Ruiz' };

function adapter() {
  const a = createRemoteAdapter({ project: 'demo', users: [], endpoint: API, notion: 'demo' });
  adapters.push(a);
  return a;
}

async function signedIn(userId = 'fake-ana') {
  localStorage.setItem('pc:v2:api.test:session', await server.signIn(userId));
}

const newThread = { page: '/', url: 'http://localhost:3000/', pin, body: 'Make it bolder', mentions: [], author: ana };

beforeEach(() => {
  localStorage.clear();
  offline = false;
  server = setup();
  vi.stubGlobal('fetch', handlerFetch(server.handler, () => offline));
});

afterEach(() => {
  adapters.forEach((a) => a.stop());
  adapters = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('remote adapter', () => {
  it('shows a new thread immediately and sends it in the background', async () => {
    await signedIn();
    const a = adapter();
    const created = await a.createThread(newThread);
    expect(created.comments[0].delivery).toBe('pending');

    await a.flushNow();
    const [local] = await a.listThreads();
    expect(local.id).toBe(created.id);
    expect(local.remoteId).toMatch(/^mem_/);
    expect(local.comments[0].delivery).toBeUndefined();
    expect((await (await server.store()).listThreads()).map((t) => t.id)).toEqual([created.id]);
  });

  it('queues changes while offline and sends them later, in order', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await signedIn();
    const a = adapter();
    offline = true;
    const t = await a.createThread(newThread);
    await a.addComment(t.id, { body: 'Reply', mentions: [], author: ana });
    await a.flushNow();
    expect(a.label).toBe('Offline · 2 waiting to send');

    offline = false;
    vi.setSystemTime(Date.now() + 10_000); // past the retry backoff
    await a.flushNow();
    expect(a.label).not.toMatch(/waiting/);
    const remoteId = (await a.listThreads())[0].remoteId!;
    expect((await (await server.store()).listComments(remoteId)).map((c) => c.body)).toEqual(['Make it bolder', 'Reply']);
  });

  it('marks rejected writes as failed and can retry them', async () => {
    await signedIn();
    const a = adapter();
    const t = await a.createThread({ ...newThread, pin: { ...pin, selector: 123 as unknown as string } });
    await a.flushNow();
    const [local] = await a.listThreads();
    expect(local.comments[0].delivery).toBe('failed');
    expect(local.comments[0].error).toMatch(/pin/);
    expect(a.label).toBe('1 change not sent');
    // A discarded unsent thread disappears.
    await a.deleteComment(t.id, local.comments[0].id);
    expect(await a.listThreads()).toEqual([]);
  });

  it('waits for sign-in before sending', async () => {
    const a = adapter();
    await a.createThread(newThread);
    await a.flushNow();
    expect(a.label).toBe('Sign in to send 1 change');
    await signedIn();
    await a.flushNow();
    expect((await (await server.store()).listThreads())).toHaveLength(1);
  });

  it('syncs other people’s changes and loads full comments on demand', async () => {
    const a = adapter();
    const ben = await server.signIn('fake-ben');
    const created = body(await server.call('POST', '/threads?db=demo', { token: ben, body: { clientId: 'x', page: '/', url: '', pin, body: 'First', mentions: [] } }));
    await server.call('POST', `/threads/${created.remoteId}/comments?db=demo`, { token: ben, body: { body: 'Second', mentions: [] } });

    await a.syncNow(true);
    let [t] = await a.listThreads();
    expect(t.comments.map((c) => c.body)).toEqual(['First']);
    expect(t.commentCount).toBe(2);

    await a.loadComments!(t.id);
    [t] = await a.listThreads();
    expect(t.comments.map((c) => c.body)).toEqual(['First', 'Second']);

    // Loaded comments are kept on later syncs while the count still matches.
    await a.syncNow(true);
    [t] = await a.listThreads();
    expect(t.comments).toHaveLength(2);
  });

  it('drops threads deleted elsewhere on a full sync', async () => {
    const a = adapter();
    const ben = await server.signIn('fake-ben');
    const created = body(await server.call('POST', '/threads?db=demo', { token: ben, body: { clientId: 'x', page: '/', url: '', pin, body: 'First', mentions: [] } }));
    await a.syncNow(true);
    expect(await a.listThreads()).toHaveLength(1);
    await server.call('DELETE', `/threads/${created.remoteId}?db=demo`, { token: ben });
    await a.syncNow(true);
    expect(await a.listThreads()).toHaveLength(0);
  });

  it('forgets an invalid session but keeps the queued change', async () => {
    localStorage.setItem('pc:v2:api.test:session', 'eyJzdWIiOiJ4IiwibmFtZSI6IngiLCJleHAiOjk5OTk5OTk5OTl9.bad');
    const a = adapter();
    await a.createThread(newThread);
    await a.flushNow();
    expect(await a.getCurrentUser()).toBeNull();
    expect(a.takeNotice!()).toMatch(/expired/);
    expect(a.label).toBe('Sign in to send 1 change');
  });

  it('picks up the token from the sign-in redirect and restores the page’s own hash', async () => {
    const token = await server.signIn('fake-ana');
    history.replaceState(null, '', `/page?x=1#${new URLSearchParams({ [AUTH_HASH.token]: token, [AUTH_HASH.returnHash]: '/route' })}`);
    const a = adapter();
    expect((await a.getCurrentUser())?.name).toBe('Ana Ruiz');
    expect(location.pathname + location.search + location.hash).toBe('/page?x=1#/route');
    expect(a.takeNotice!()).toBe('Signed in as Ana Ruiz');
  });
});
