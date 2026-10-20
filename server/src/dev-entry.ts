// Loaded by the Vite dev plugin through ssrLoadModule, so edits to server code apply without a restart.
import { resolve } from 'node:path';
import { buildApp } from './app';
import { toNodeListener } from './node';
import { FAKE_USERS, MemoryWorkspace } from './stores/memory';

const app = buildApp(process.env, { dev: true, fakeWorkspace: () => new MemoryWorkspace(FAKE_USERS, resolve('.data/fake-notion.json')) });

export const mode = app.mode;
export const listener = toNodeListener(app.handler);
