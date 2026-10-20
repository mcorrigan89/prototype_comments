// Loaded by the Vite dev plugin through ssrLoadModule, so edits to server code apply without a restart.
import { resolve } from 'node:path';
import { buildApp } from './app';
import { toNodeListener } from './node';

const app = buildApp(process.env, { dev: true, fakeDataFile: resolve('.data/fake-notion.json') });

export const mode = app.mode;
export const listener = toNodeListener(app.handler);
