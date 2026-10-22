import { describe, expect, it } from 'vitest';
import { functionUrlHandler, type FunctionUrlEvent } from '../../server/src/lambda';
import { PROTOTYPE, pin, setup } from './helpers';

function event(method: string, path: string, init: Partial<FunctionUrlEvent> = {}): FunctionUrlEvent {
  const [rawPath, rawQueryString = ''] = path.split('?');
  return { rawPath, rawQueryString, headers: { host: 'abc.lambda-url.us-east-2.on.aws', origin: PROTOTYPE }, requestContext: { http: { method } }, ...init };
}

describe('Lambda Function URL adapter', () => {
  it('passes method, path, query and headers through, and returns CORS headers', async () => {
    const { handler } = setup();
    const lambda = functionUrlHandler(() => handler);
    const res = await lambda(event('GET', '/threads?db=demo'));
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(PROTOTYPE);
    expect(JSON.parse(res.body)).toMatchObject({ threads: [] });
  });

  it('decodes base64 bodies and lower-cases header names', async () => {
    const { handler, signIn } = setup();
    const token = await signIn();
    const lambda = functionUrlHandler(() => handler);
    const payload = { clientId: 'c-1', page: '/', url: `${PROTOTYPE}/`, pin, body: 'Hi', mentions: [] };
    const res = await lambda(
      event('POST', '/threads?db=demo', {
        headers: { Host: 'abc.lambda-url.us-east-2.on.aws', Origin: PROTOTYPE, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify(payload)).toString('base64'),
        isBase64Encoded: true,
      }),
    );
    expect(res.statusCode).toBe(201);
    expect(res.headers['access-control-allow-origin']).toBe(PROTOTYPE);
  });

  it('returns redirects with an empty body', async () => {
    const { handler } = setup();
    const res = await functionUrlHandler(() => handler)(event('GET', `/auth/start?return=${encodeURIComponent(`${PROTOTYPE}/x.html`)}`));
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBeTruthy();
    expect(res.body).toBe('');
  });
});
