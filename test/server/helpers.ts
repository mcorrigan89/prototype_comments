import { AUTH_HASH } from '../../src/api';
import type { Pin, User } from '../../src/types';
import { createHandler, type AppConfig } from '../../server/src/handler';
import type { ApiResponse, Handler } from '../../server/src/http';
import { fakeIdentity } from '../../server/src/identity';
import { FAKE_USERS, MemoryWorkspace } from '../../server/src/stores/memory';

export const PROTOTYPE = 'http://proto.test';
export const API = 'http://api.test';

export const pin: Pin = { selector: '#cta', tag: 'button', text: 'Buy', offset: { x: 0.5, y: 0.5 }, page: { x: 10, y: 20 }, viewport: { w: 1200, h: 800 } };

export function setup({ members = FAKE_USERS, signInUsers = FAKE_USERS, config = {} as Partial<AppConfig> } = {}) {
  const workspace = new MemoryWorkspace(members);
  const handler = createHandler({
    workspace,
    identity: fakeIdentity(signInUsers),
    config: {
      sessionSecret: 'test-secret-0123456789',
      allowedOrigins: [PROTOTYPE, 'http://localhost:3000'],
      privateDatabases: new Set(['secret']),
      sessionDays: 30,
      publicUrl: API,
      ...config,
    },
  });

  const call = (method: string, path: string, { body, token, origin = PROTOTYPE }: { body?: unknown; token?: string | null; origin?: string } = {}) => {
    const url = new URL(path, API);
    return handler({
      method,
      path: url.pathname,
      query: url.searchParams,
      headers: { host: 'api.test', origin, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };

  /** Runs the whole sign-in redirect dance and returns the final redirect back to the prototype. */
  async function signInRedirect(userId: string, returnTo = `${PROTOTYPE}/page.html#/route`): Promise<URL> {
    const start = await call('GET', `/auth/start?${new URLSearchParams({ return: returnTo, popup: '1' })}`);
    const fakePage = new URL(start.headers!.location);
    const state = fakePage.searchParams.get('state')!;
    const callback = await call('GET', `/auth/callback?${new URLSearchParams({ code: userId, state })}`);
    return new URL(callback.headers!.location);
  }

  async function signIn(userId = 'fake-ana'): Promise<string> {
    const back = await signInRedirect(userId);
    return new URLSearchParams(back.hash.slice(1)).get(AUTH_HASH.token)!;
  }

  return { workspace, store: (db = 'demo') => workspace.open(db), handler, call, signIn, signInRedirect };
}

export const body = <T = any>(res: ApiResponse): T => JSON.parse(res.body ?? 'null');

/** A fetch that sends requests straight to the handler, for testing the browser adapter. */
export function handlerFetch(handler: Handler, isOffline: () => boolean = () => false): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    if (isOffline()) throw new TypeError('Failed to fetch');
    const url = new URL(String(input));
    const headers: Record<string, string> = { host: url.host, origin: 'http://localhost:3000' };
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const res = await handler({
      method: init.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers,
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    return new Response(res.status === 204 ? null : (res.body ?? null), { status: res.status, headers: res.headers });
  }) as typeof fetch;
}

export const mention = (u: User) => ({ id: u.id, name: u.name });
