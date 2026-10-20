import { describe, expect, it } from 'vitest';
import { AUTH_HASH } from '../../src/api';
import { FAKE_USERS } from '../../server/src/stores/memory';
import { API, PROTOTYPE, body, mention, pin, setup } from './helpers';

const thread = (overrides: Record<string, unknown> = {}) => ({
  clientId: 'client-1',
  page: '/',
  url: `${PROTOTYPE}/`,
  pin,
  body: 'Hello @Ben Okafor',
  mentions: [mention(FAKE_USERS[1])],
  ...overrides,
});

describe('sign-in', () => {
  it('redirects through the identity provider and back with a token in the hash', async () => {
    const { signInRedirect, call } = setup();
    const back = await signInRedirect('fake-ana');
    expect(back.origin + back.pathname).toBe(`${PROTOTYPE}/page.html`);
    const hash = new URLSearchParams(back.hash.slice(1));
    expect(hash.get(AUTH_HASH.returnHash)).toBe('/route');
    expect(hash.get(AUTH_HASH.popup)).toBe('1');

    const token = hash.get(AUTH_HASH.token)!;
    const users = await call('GET', '/users', { token });
    expect(users.status).toBe(200);
  });

  it('refuses to send tokens to origins that are not allowed', async () => {
    const { call } = setup();
    const res = await call('GET', `/auth/start?return=${encodeURIComponent('https://evil.test/')}`);
    expect(res.status).toBe(403);
  });

  it('rejects a tampered state', async () => {
    const { call } = setup();
    const res = await call('GET', '/auth/callback?code=fake-ana&state=abc.def');
    expect(res.status).toBe(400);
  });

  it('only lets workspace members sign in', async () => {
    const outsider = { id: 'outsider', name: 'Mallory' };
    const { signInRedirect } = setup({ members: FAKE_USERS, signInUsers: [...FAKE_USERS, outsider] });
    const hash = new URLSearchParams((await signInRedirect('outsider')).hash.slice(1));
    expect(hash.get(AUTH_HASH.token)).toBeNull();
    expect(hash.get(AUTH_HASH.error)).toMatch(/members/);
  });

  it('rejects forged session tokens', async () => {
    const { call, signIn } = setup();
    const token = await signIn();
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), sub: 'fake-ben' })).toString('base64url');
    expect((await call('GET', '/users', { token: `${forged}.${sig}` })).status).toBe(401);
  });
});

describe('threads', () => {
  it('requires sign-in to write, and takes the author from the token', async () => {
    const { call, signIn } = setup();
    expect((await call('POST', '/threads?db=demo', { body: thread() })).status).toBe(401);

    const token = await signIn('fake-ana');
    const res = await call('POST', '/threads?db=demo', { token, body: { ...thread(), author: { id: 'fake-ben', name: 'Spoofed' } } });
    expect(res.status).toBe(201);
    const created = body(res);
    expect(created.id).toBe('client-1');
    expect(created.createdBy.name).toBe('Ana Ruiz');
    expect(created.comments[0].mentions).toEqual([{ id: 'fake-ben', name: 'Ben Okafor' }]);
  });

  it('is idempotent per clientId', async () => {
    const { call, signIn } = setup();
    const token = await signIn();
    const first = body(await call('POST', '/threads?db=demo', { token, body: thread() }));
    const again = await call('POST', '/threads?db=demo', { token, body: thread() });
    expect(again.status).toBe(200);
    expect(body(again).remoteId).toBe(first.remoteId);
  });

  it('drops mentions of people who are not workspace members', async () => {
    const { call, signIn } = setup();
    const token = await signIn();
    const res = body(await call('POST', '/threads?db=demo', { token, body: thread({ mentions: [{ id: 'nope', name: 'Nobody' }] }) }));
    expect(res.comments[0].mentions).toEqual([]);
  });

  it('validates input', async () => {
    const { call, signIn } = setup();
    const token = await signIn();
    expect((await call('POST', '/threads?db=demo', { token, body: thread({ pin: { selector: 1 } }) })).status).toBe(400);
    expect((await call('POST', '/threads', { token, body: thread() })).status).toBe(400); // no db
    expect((await call('POST', '/threads?db=demo', { token, body: thread({ body: '   ' }) })).status).toBe(400);
  });

  it('lists everything, or only what changed since a time', async () => {
    const { call, signIn } = setup();
    const token = await signIn();
    const a = body(await call('POST', '/threads?db=demo', { token, body: thread({ clientId: 'a' }) }));
    await call('POST', '/threads?db=demo', { token, body: thread({ clientId: 'b' }) });

    const full = body(await call('GET', '/threads?db=demo'));
    expect(full.full).toBe(true);
    expect(full.threads.map((t: any) => t.id)).toEqual(['a', 'b']);

    // The server subtracts a 2 minute overlap, so ask from the future to isolate one change.
    const later = new Date(Date.now() + 3 * 60_000).toISOString();
    await new Promise((r) => setTimeout(r, 5));
    const resolved = body(await call('PATCH', `/threads/${a.remoteId}?db=demo`, { token, body: { status: 'resolved' } }));
    expect(resolved.resolvedBy.name).toBe('Ana Ruiz');
    const sinceRes = body(await call('GET', `/threads?db=demo&since=${encodeURIComponent(later)}`));
    expect(sinceRes.full).toBe(false);
    expect(sinceRes.threads).toEqual([]);
    expect(body(await call('GET', '/threads?db=other')).threads).toEqual([]);
  });

  it('keeps private projects behind sign-in', async () => {
    const { call, signIn } = setup();
    expect((await call('GET', '/threads?db=secret')).status).toBe(401);
    expect((await call('GET', '/threads?db=secret', { token: await signIn() })).status).toBe(200);
    expect((await call('GET', '/threads?db=demo')).status).toBe(200);
  });

  it('adds comments and skips a retried duplicate', async () => {
    const { call, signIn } = setup();
    const token = await signIn();
    const t = body(await call('POST', '/threads?db=demo', { token, body: thread() }));
    const reply = { body: 'Reply', mentions: [] };
    expect(body(await call('POST', `/threads/${t.remoteId}/comments?db=demo`, { token, body: reply })).comments).toHaveLength(2);
    expect(body(await call('POST', `/threads/${t.remoteId}/comments?db=demo`, { token, body: { ...reply, retry: true } })).comments).toHaveLength(2);
    expect(body(await call('GET', `/threads/${t.remoteId}/comments?db=demo`)).comments.map((c: any) => c.body)).toEqual(['Hello @Ben Okafor', 'Reply']);

    const summary = body(await call('GET', '/threads?db=demo')).threads[0];
    expect(summary.comments).toHaveLength(1);
    expect(summary.commentCount).toBe(2);
  });

  it('lets only the author delete a thread', async () => {
    const { call, signIn } = setup();
    const ana = await signIn('fake-ana');
    const t = body(await call('POST', '/threads?db=demo', { token: ana, body: thread() }));
    expect((await call('DELETE', `/threads/${t.remoteId}?db=demo`, { token: await signIn('fake-ben') })).status).toBe(403);
    expect((await call('DELETE', `/threads/${t.remoteId}?db=other`, { token: ana })).status).toBe(404); // wrong database
    expect((await call('DELETE', `/threads/${t.remoteId}?db=demo`, { token: ana })).status).toBe(204);
    expect((await call('GET', `/threads/${t.remoteId}/comments?db=demo`)).status).toBe(404);
    expect((await call('GET', '/threads/..%2Fusers/comments?db=demo')).status).toBe(404);
  });
});

describe('CORS', () => {
  it('allows configured origins only', async () => {
    const { call } = setup();
    const ok = await call('OPTIONS', '/threads');
    expect(ok.headers?.['access-control-allow-origin']).toBe(PROTOTYPE);
    const bad = await call('GET', '/threads?db=demo', { origin: 'https://evil.test' });
    expect(bad.headers?.['access-control-allow-origin']).toBeUndefined();
  });

  it('serves the fake sign-in page only in fake mode', async () => {
    const { call } = setup();
    const start = await call('GET', `/auth/start?return=${encodeURIComponent(PROTOTYPE + '/')}`);
    const page = await call('GET', new URL(start.headers!.location).pathname + new URL(start.headers!.location).search);
    expect(page.status).toBe(200);
    expect(page.body).toContain('Ana Ruiz');
    expect(start.headers!.location.startsWith(`${API}/auth/fake?`)).toBe(true);
  });
});
