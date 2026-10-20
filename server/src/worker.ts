import { buildApp } from './app';
import type { ApiRequest, Handler } from './http';

/**
 * Cloudflare Workers entry. Workers pass configuration as `env` on each request
 * (vars from wrangler.jsonc plus secrets), so the handler is built on the first
 * request and reused while this isolate stays warm.
 */
let app: Handler | null = null;

export default {
  async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
    app ??= buildApp(Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string'))).handler;

    const url = new URL(request.url);
    const headers: ApiRequest['headers'] = {};
    request.headers.forEach((value, key) => (headers[key] = value));
    const res = await app({
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text(),
    });
    return new Response(res.status === 204 || res.status === 302 ? null : (res.body ?? null), { status: res.status, headers: res.headers });
  },
};
