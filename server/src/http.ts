import type { ErrorResponse } from '../../src/api';

/** Runtime-agnostic request: the Lambda and local Node adapters both convert to this. */
export interface ApiRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  /** Lower-cased header names. */
  headers: Record<string, string | undefined>;
  body?: string;
}

export interface ApiResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

export type Handler = (req: ApiRequest) => Promise<ApiResponse>;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: ErrorResponse['code'] = 'bad_request',
  ) {
    super(message);
  }
}

export const unauthorized = (message = 'Sign in to do that') => new HttpError(401, message, 'unauthorized');
export const forbidden = (message: string) => new HttpError(403, message, 'forbidden');
export const notFound = (message = 'Not found') => new HttpError(404, message, 'not_found');
export const badRequest = (message: string) => new HttpError(400, message, 'bad_request');

export function json(status: number, data: unknown, headers: Record<string, string> = {}): ApiResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
    body: JSON.stringify(data),
  };
}

export function html(status: number, markup: string): ApiResponse {
  return {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    },
    body: markup,
  };
}

export function redirect(location: string): ApiResponse {
  return { status: 302, headers: { location, 'cache-control': 'no-store' } };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
