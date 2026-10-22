import { buildApp } from './app';
import type { ApiRequest, Handler } from './http';

/** The subset of a Lambda Function URL event (payload format 2.0) that we use. */
export interface FunctionUrlEvent {
  rawPath: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string } };
}

export interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/** Wraps the runtime-agnostic handler for a Lambda Function URL. */
export function functionUrlHandler(getApp: () => Handler) {
  return async (event: FunctionUrlEvent): Promise<FunctionUrlResult> => {
    const headers: ApiRequest['headers'] = {};
    for (const [key, value] of Object.entries(event.headers ?? {})) headers[key.toLowerCase()] = value;
    const res = await getApp()({
      method: event.requestContext.http.method,
      path: event.rawPath,
      query: new URLSearchParams(event.rawQueryString ?? ''),
      headers,
      body: event.body && event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body,
    });
    return { statusCode: res.status, headers: res.headers ?? {}, body: res.body ?? '' };
  };
}

// Built on the first request and reused while the container stays warm (keeps the users cache warm).
// Configuration comes from the function's environment variables, set by `npm run lambda:deploy`.
let app: Handler | null = null;

export const handler = functionUrlHandler(() => (app ??= buildApp(process.env).handler));
