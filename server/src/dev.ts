import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { buildApp } from './app';
import { toNodeListener } from './node';
import { FAKE_USERS, MemoryWorkspace } from './stores/memory';

export const DEV_API_PORT = 8787;

/** Starts the API locally: fake Notion unless real credentials are in the environment. */
export function startDevApi(env: Record<string, string | undefined> = process.env, port = Number(env.API_PORT) || DEV_API_PORT): Server {
  const { handler, mode } = buildApp(env, { dev: true, fakeWorkspace: () => new MemoryWorkspace(FAKE_USERS, resolve('.data/fake-notion.json')) });
  const server = createServer(toNodeListener(handler));
  server.listen(port, () => {
    const label = mode.store === 'notion' ? 'real Notion' : 'fake Notion (.data/fake-notion.json)';
    console.log(`  ➜  API:     http://localhost:${port}/  ·  ${label}, ${mode.identity} sign-in`);
  });
  return server;
}
