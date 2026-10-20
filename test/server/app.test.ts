import { describe, expect, it } from 'vitest';
import { buildApp } from '../../server/src/app';

// Every key from .env.example, left blank, as in a freshly copied .env.
const blankEnv = {
  NOTION_TOKEN: '',
  NOTION_CLIENT_ID: '',
  NOTION_CLIENT_SECRET: '',
  SESSION_SECRET: '',
  ALLOWED_ORIGINS: '',
  PRIVATE_DATABASES: '',
  PUBLIC_URL: '',
  SESSION_DAYS: '',
};

describe('buildApp', () => {
  it('starts in dev from a freshly copied, blank .env', async () => {
    const { handler, mode } = buildApp(blankEnv, { dev: true });
    expect(mode).toEqual({ store: 'fake', identity: 'fake' });
    const res = await handler({ method: 'OPTIONS', path: '/threads', query: new URLSearchParams(), headers: { origin: 'http://localhost:5173' } });
    expect(res.headers?.['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('uses dev sign-in with a real token but no public integration', () => {
    expect(buildApp({ ...blankEnv, NOTION_TOKEN: 'ntn_test' }, { dev: true }).mode).toEqual({ store: 'notion', identity: 'fake' });
  });

  it('refuses to start in production without real configuration', () => {
    expect(() => buildApp(blankEnv)).toThrow(/NOTION_TOKEN/);
    expect(() => buildApp({ ...blankEnv, NOTION_TOKEN: 'x', NOTION_CLIENT_ID: 'c', NOTION_CLIENT_SECRET: 's', SESSION_SECRET: '0123456789abcdef' })).toThrow(/ALLOWED_ORIGINS/);
  });
});
