import { buildApp } from './app';
import type { ApiRequest } from './http';

/** The subset of a Lambda Function URL event (payload format 2.0) that we use. */
interface FunctionUrlEvent {
  rawPath: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string } };
}

// Built once per container, reused across invocations (keeps the users cache warm).
const { handler: app } = buildApp(process.env);

export async function handler(event: FunctionUrlEvent) {
  const headers: ApiRequest['headers'] = {};
  for (const [key, value] of Object.entries(event.headers ?? {})) headers[key.toLowerCase()] = value;
  const res = await app({
    method: event.requestContext.http.method,
    path: event.rawPath,
    query: new URLSearchParams(event.rawQueryString ?? ''),
    headers,
    body: event.body && event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body,
  });
  return { statusCode: res.status, headers: res.headers ?? {}, body: res.body ?? '' };
}
