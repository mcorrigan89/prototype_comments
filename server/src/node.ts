import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiRequest, Handler } from './http';

/** Adapts the runtime-agnostic handler to Node's http module, for local development. */
export function toNodeListener(handler: Handler) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const headers: ApiRequest['headers'] = { 'x-forwarded-proto': 'http' };
    for (const [key, value] of Object.entries(req.headers)) headers[key] = Array.isArray(value) ? value.join(', ') : value;

    const result = await handler({
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers,
      body: chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined,
    });
    res.writeHead(result.status, result.headers);
    res.end(result.body);
  };
}
