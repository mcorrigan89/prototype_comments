import {
  AUTH_HASH,
  userFromClaims,
  type AddCommentBody,
  type CreateThreadBody,
  type SessionClaims,
  type SyncResponse,
  type UpdateThreadBody,
} from '../../src/api';
import type { Pin, User } from '../../src/types';
import { HttpError, badRequest, escapeHtml, forbidden, html, json, notFound, redirect, unauthorized, type ApiRequest, type ApiResponse, type Handler } from './http';
import { notionIdFrom, type Identity, type Store, type Workspace } from './ports';
import { nowSeconds, sign, verify } from './session';

export interface AppConfig {
  sessionSecret: string;
  /**
   * Origins (scheme://host[:port]) of the prototypes allowed to call the API and
   * receive sign-in tokens. `*` matches one part of a hostname (letters, digits,
   * dashes; never a dot), e.g. http://govwell-*-prototype.s3-website.us-east-2.amazonaws.com
   */
  allowedOrigins: string[];
  /** Feedback databases (Notion ids) whose comments can only be read after signing in. */
  privateDatabases: Set<string>;
  /** This API's own base URL. Derived from the request when not set. */
  publicUrl?: string;
  sessionDays: number;
}

export interface AppDeps {
  workspace: Workspace;
  identity: Identity;
  config: AppConfig;
}

const MAX_BODY_BYTES = 64 * 1024;
const MAX_COMMENT = 5000;
/** Notion's last_edited_time is minute-precision, so overlap delta syncs a little. */
const SINCE_OVERLAP_MS = 2 * 60 * 1000;
const STATE_TTL_SECONDS = 10 * 60;
const DUPLICATE_WINDOW_MS = 15 * 60 * 1000;
const REMOTE_ID_RE = /^[\w-]{1,64}$/;

interface OAuthState {
  ret: string;
  popup: boolean;
  exp: number;
}

export function createHandler({ workspace, identity, config }: AppDeps): Handler {
  const secret = config.sessionSecret;
  const privateDatabases = new Set([...config.privateDatabases].map((ref) => notionIdFrom(ref) ?? ref));

  // ---------- helpers ----------

  const originMatchers = config.allowedOrigins.map(originMatcher);

  function isAllowedOrigin(origin: string | undefined): origin is string {
    return !!origin && originMatchers.some((matches) => matches(origin));
  }

  function corsHeaders(origin: string | undefined): Record<string, string> {
    if (!isAllowedOrigin(origin)) return { vary: 'Origin' };
    return { 'access-control-allow-origin': origin, vary: 'Origin' };
  }

  function baseUrl(req: ApiRequest): string {
    if (config.publicUrl) return config.publicUrl.replace(/\/$/, '');
    const proto = req.headers['x-forwarded-proto'] ?? 'https';
    return `${proto}://${req.headers.host}`;
  }

  function currentUser(req: ApiRequest): User | null {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const claims = verify<SessionClaims>(secret, 'session', token);
    return claims ? userFromClaims(claims) : null;
  }

  function requireUser(req: ApiRequest): User {
    const user = currentUser(req);
    if (!user) throw unauthorized();
    return user;
  }

  function assertCanRead(req: ApiRequest, store: Store) {
    if (privateDatabases.has(store.id) && !currentUser(req)) throw unauthorized('Sign in to view these comments');
  }

  /** The prototype's comments, from ?db= (the script tag's data-notion). */
  async function database(req: ApiRequest, { create = false } = {}): Promise<Store> {
    const ref = req.query.get('db');
    if (!ref) throw badRequest('db is required (the script tag’s data-notion)');
    if (ref.length > 300) throw badRequest('db is too long');
    return workspace.open(ref, { create });
  }

  function readJson<T>(req: ApiRequest): Partial<T> {
    if (!req.body) throw badRequest('Missing request body');
    if (Buffer.byteLength(req.body) > MAX_BODY_BYTES) throw badRequest('Request body too large');
    try {
      const data = JSON.parse(req.body);
      if (!data || typeof data !== 'object') throw new Error();
      return data;
    } catch {
      throw badRequest('Request body must be JSON');
    }
  }

  function text(value: unknown, field: string, max: number, { allowEmpty = false } = {}): string {
    if (typeof value !== 'string') throw badRequest(`${field} is required`);
    const trimmed = value.trim();
    if (!allowEmpty && !trimmed) throw badRequest(`${field} is required`);
    if (trimmed.length > max) throw badRequest(`${field} is too long`);
    return trimmed;
  }

  function remoteId(value: string): string {
    if (!REMOTE_ID_RE.test(value)) throw notFound();
    return value;
  }

  function pin(value: unknown): Pin {
    const p = value as Pin;
    const num = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
    const ok =
      p &&
      typeof p.selector === 'string' &&
      p.selector.length <= 1000 &&
      typeof p.tag === 'string' &&
      p.tag.length <= 40 &&
      typeof p.text === 'string' &&
      p.text.length <= 200 &&
      num(p.offset?.x) &&
      num(p.offset?.y) &&
      num(p.page?.x) &&
      num(p.page?.y) &&
      num(p.viewport?.w) &&
      num(p.viewport?.h);
    if (!ok) throw badRequest('pin is invalid');
    return {
      selector: p.selector,
      tag: p.tag,
      text: p.text,
      offset: { x: p.offset.x, y: p.offset.y },
      page: { x: p.page.x, y: p.page.y },
      viewport: { w: p.viewport.w, h: p.viewport.h },
    };
  }

  /** Keeps only mentions of real people, so nobody can inject arbitrary ids. */
  async function mentions(value: unknown): Promise<User[]> {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 20) throw badRequest('mentions is invalid');
    const ids = new Set(value.map((m) => (m && typeof m.id === 'string' ? m.id : '')));
    if (!ids.size) return [];
    const people = await workspace.listUsers();
    return people.filter((u) => ids.has(u.id)).map((u) => ({ id: u.id, name: u.name }));
  }

  async function threadOr404(store: Store, id: string) {
    const thread = await store.getThread(remoteId(id));
    if (!thread) throw notFound('That thread no longer exists');
    return thread;
  }

  /** Validates a prototype URL we're about to send a token to. */
  function returnUrl(value: string | null): URL {
    let url: URL;
    try {
      url = new URL(value ?? '');
    } catch {
      throw badRequest('Invalid return URL');
    }
    if (!/^https?:$/.test(url.protocol) || !isAllowedOrigin(url.origin)) {
      throw forbidden(`${url.origin} isn't an allowed prototype origin. Add it to ALLOWED_ORIGINS.`);
    }
    return url;
  }

  function backToPrototype(state: OAuthState, params: Record<string, string>): ApiResponse {
    const url = new URL(state.ret);
    const hash = new URLSearchParams(params);
    if (url.hash) hash.set(AUTH_HASH.returnHash, url.hash.slice(1));
    if (state.popup) hash.set(AUTH_HASH.popup, '1');
    url.hash = hash.toString();
    return redirect(url.toString());
  }

  // ---------- routes ----------

  async function authStart(req: ApiRequest): Promise<ApiResponse> {
    const ret = returnUrl(req.query.get('return'));
    const state = sign<OAuthState>(secret, 'oauth', {
      ret: ret.toString(),
      popup: req.query.get('popup') === '1',
      exp: nowSeconds() + STATE_TTL_SECONDS,
    });
    return redirect(identity.authorizeUrl(state, `${baseUrl(req)}/auth/callback`));
  }

  async function authCallback(req: ApiRequest): Promise<ApiResponse> {
    const state = verify<OAuthState>(secret, 'oauth', req.query.get('state'));
    if (!state) return html(400, page('Sign-in expired', 'That sign-in link has expired. Close this window and try again.'));
    // Re-check: ALLOWED_ORIGINS may have changed since the state was issued.
    returnUrl(state.ret);

    const code = req.query.get('code');
    if (!code) return backToPrototype(state, { [AUTH_HASH.error]: req.query.get('error') === 'access_denied' ? 'Sign-in was cancelled' : 'Sign-in failed' });

    let user: User;
    try {
      user = await identity.exchange(code, `${baseUrl(req)}/auth/callback`);
    } catch (err) {
      console.error('sign-in failed', err);
      return backToPrototype(state, { [AUTH_HASH.error]: 'Sign-in failed' });
    }
    const members = await workspace.listUsers();
    if (!members.some((m) => m.id === user.id)) {
      return backToPrototype(state, { [AUTH_HASH.error]: 'Only members of the workspace can comment' });
    }

    const token = sign<SessionClaims>(secret, 'session', {
      sub: user.id,
      name: user.name,
      ...(user.email ? { email: user.email } : {}),
      ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
      exp: nowSeconds() + config.sessionDays * 86400,
    });
    return backToPrototype(state, { [AUTH_HASH.token]: token });
  }

  /** Local development only: stands in for Notion's consent screen. */
  async function authFake(req: ApiRequest): Promise<ApiResponse> {
    if (identity.kind !== 'fake') throw notFound();
    const state = req.query.get('state') ?? '';
    if (!verify<OAuthState>(secret, 'oauth', state)) return html(400, page('Sign-in expired', 'Close this window and try again.'));
    const users = await workspace.listUsers();
    const links = users
      .map((u) => {
        const href = `${baseUrl(req)}/auth/callback?${new URLSearchParams({ code: u.id, state })}`;
        return `<a class="user" href="${escapeHtml(href)}"><span>${escapeHtml(u.name)}</span><small>${escapeHtml(u.email ?? '')}</small></a>`;
      })
      .join('');
    return html(
      200,
      page(
        'Sign in (fake Notion)',
        `<p>Local development: pick who you want to be. In production this is Notion's sign-in screen.</p>${links}
         <a class="cancel" href="${escapeHtml(`${baseUrl(req)}/auth/callback?${new URLSearchParams({ error: 'access_denied', state })}`)}">Cancel</a>`,
      ),
    );
  }

  async function listThreads(req: ApiRequest): Promise<ApiResponse> {
    const store = await database(req);
    assertCanRead(req, store);
    const sinceParam = req.query.get('since');
    let since: string | undefined;
    if (sinceParam) {
      const t = Date.parse(sinceParam);
      if (Number.isNaN(t)) throw badRequest('since must be an ISO date');
      since = new Date(t - SINCE_OVERLAP_MS).toISOString();
    }
    const serverTime = new Date().toISOString();
    const threads = await store.listThreads(since);
    return json(200, { threads, full: !since, serverTime } satisfies SyncResponse);
  }

  async function createThread(req: ApiRequest): Promise<ApiResponse> {
    const author = requireUser(req);
    const body = readJson<CreateThreadBody>(req);
    // Only a signed-in write may create the comments database.
    const store = await database(req, { create: true });
    const input: CreateThreadBody = {
      clientId: text(body.clientId, 'clientId', 64),
      page: text(body.page, 'page', 500),
      url: text(body.url, 'url', 2000, { allowEmpty: true }),
      pin: pin(body.pin),
      body: text(body.body, 'body', MAX_COMMENT),
      mentions: await mentions(body.mentions),
    };
    // Retries after a lost response must not create a second row.
    const existing = await store.findByClientId(input.clientId);
    if (existing) return json(200, existing);
    return json(201, await store.createThread({ ...input, author }));
  }

  async function updateThread(req: ApiRequest, id: string): Promise<ApiResponse> {
    const user = requireUser(req);
    const body = readJson<UpdateThreadBody>(req);
    if (body.status !== 'open' && body.status !== 'resolved') throw badRequest('status must be "open" or "resolved"');
    const store = await database(req);
    const thread = await threadOr404(store, id);
    return json(200, await store.setStatus(thread.remoteId ?? id, body.status, user));
  }

  async function deleteThread(req: ApiRequest, id: string): Promise<ApiResponse> {
    const user = requireUser(req);
    const store = await database(req);
    const thread = await threadOr404(store, id);
    if (thread.createdBy.id !== user.id) throw forbidden('Only the person who started a thread can delete it');
    await store.trashThread(thread.remoteId ?? id);
    return { status: 204 };
  }

  async function listComments(req: ApiRequest, id: string): Promise<ApiResponse> {
    const store = await database(req);
    assertCanRead(req, store);
    const thread = await threadOr404(store, id);
    return json(200, { comments: await store.listComments(thread.remoteId ?? id) });
  }

  async function addComment(req: ApiRequest, id: string): Promise<ApiResponse> {
    const author = requireUser(req);
    const body = readJson<AddCommentBody>(req);
    const input = { body: text(body.body, 'body', MAX_COMMENT), mentions: await mentions(body.mentions), author };
    const store = await database(req);
    const thread = await threadOr404(store, id);
    const target = thread.remoteId ?? id;
    if (body.retry) {
      const comments = await store.listComments(target);
      const cutoff = Date.now() - DUPLICATE_WINDOW_MS;
      const dup = comments.some((c) => c.author.id === author.id && c.body === input.body && Date.parse(c.createdAt) > cutoff);
      if (dup) return json(200, { comments });
    }
    return json(201, { comments: await store.addComment(target, input) });
  }

  async function route(req: ApiRequest): Promise<ApiResponse> {
    const [first, id, sub, ...rest] = req.path.split('/').filter(Boolean);
    const key = `${req.method} /${[first, id && ':id', sub].filter(Boolean).join('/')}`;
    if (rest.length) throw notFound();

    switch (key) {
      case 'GET /':
      case 'GET /health':
        return json(200, { ok: true, identity: identity.kind });
      case 'GET /auth/:id':
        if (id === 'start') return authStart(req);
        if (id === 'callback') return authCallback(req);
        if (id === 'fake') return authFake(req);
        throw notFound();
      case 'GET /threads':
        return listThreads(req);
      case 'POST /threads':
        return createThread(req);
      case 'PATCH /threads/:id':
        return updateThread(req, id);
      case 'DELETE /threads/:id':
        return deleteThread(req, id);
      case 'GET /threads/:id/comments':
        return listComments(req, id);
      case 'POST /threads/:id/comments':
        return addComment(req, id);
      case 'GET /users':
        requireUser(req);
        return json(200, { users: await workspace.listUsers() });
      default:
        throw notFound();
    }
  }

  return async (req) => {
    const cors = corsHeaders(req.headers.origin);
    if (req.method === 'OPTIONS') {
      return {
        status: 204,
        headers: {
          ...cors,
          'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'access-control-allow-headers': 'authorization, content-type',
          'access-control-max-age': '600',
        },
      };
    }
    let res: ApiResponse;
    try {
      res = await route(req);
    } catch (err) {
      if (err instanceof HttpError) {
        res = json(err.status, { error: err.message, code: err.code });
      } else {
        console.error(err);
        const status = (err as { status?: number }).status;
        res =
          status === 429
            ? json(503, { error: 'Notion is busy, try again in a moment', code: 'busy' })
            : json(502, { error: 'Couldn’t reach Notion', code: 'upstream' });
      }
    }
    return { ...res, headers: { ...res.headers, ...cors } };
  };
}

/** Exact match, or a pattern where `*` stands for one hostname part (never crossing a dot). */
export function originMatcher(allowed: string): (origin: string) => boolean {
  if (!allowed.includes('*')) return (origin) => origin === allowed;
  const re = new RegExp(`^${allowed.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[a-z0-9-]+')}$`, 'i');
  return (origin) => re.test(origin);
}

function page(title: string, content: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
body{font:15px/1.5 system-ui,sans-serif;max-width:420px;margin:48px auto;padding:0 16px;color:#1d1d1f}
h1{font-size:20px}.user{display:flex;justify-content:space-between;padding:12px 14px;margin:8px 0;border:1px solid #ddd;border-radius:10px;color:inherit;text-decoration:none}
.user:hover{border-color:#0d99ff;background:#f0f8ff}small{color:#777}.cancel{display:inline-block;margin-top:12px;color:#777}
</style></head><body><h1>${escapeHtml(title)}</h1>${content}</body></html>`;
}
