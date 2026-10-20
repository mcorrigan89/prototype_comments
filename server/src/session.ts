import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stateless signed tokens: base64url(JSON payload) + "." + base64url(HMAC-SHA256).
 * Used for sessions and for the OAuth `state` parameter. Nothing is stored server-side.
 */

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

function signature(secret: string, payload: string): string {
  return b64url(createHmac('sha256', secret).update(payload).digest());
}

/** `purpose` stops a token minted for one job (e.g. OAuth state) being replayed as another. */
export function sign<T extends object>(secret: string, purpose: string, claims: T & { exp: number }): string {
  const payload = b64url(JSON.stringify({ ...claims, pur: purpose }));
  return `${payload}.${signature(secret, `${purpose}.${payload}`)}`;
}

export function verify<T extends { exp: number }>(secret: string, purpose: string, token: string | undefined | null): T | null {
  if (!token) return null;
  const [payload, sig, extra] = token.split('.');
  if (!payload || !sig || extra !== undefined) return null;
  const expected = Buffer.from(signature(secret, `${purpose}.${payload}`));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (claims.pur !== purpose || typeof claims.exp !== 'number' || claims.exp < Date.now() / 1000) return null;
    delete claims.pur;
    return claims as T;
  } catch {
    return null;
  }
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);
