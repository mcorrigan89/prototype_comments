/// <reference types="vitest/config" />
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import pkg from './package.json' with { type: 'json' };

const API_PORT = 8787;

/** Runs the backend (server/) next to the dev server, reloading it when its code changes. */
function devApi(): Plugin {
  return {
    name: 'prototype-comments:dev-api',
    // Not under Vitest, which also loads this config.
    apply: (_, env) => env.command === 'serve' && !process.env.VITEST,
    configureServer(server) {
      // Same .env the standalone server and Lambda use; real env vars win.
      for (const [key, value] of Object.entries(loadEnv(server.config.mode, process.cwd(), ''))) process.env[key] ??= value;

      const load = () => server.ssrLoadModule('/server/src/dev-entry.ts') as Promise<typeof import('./server/src/dev-entry')>;
      const api = createServer(async (req, res) => {
        try {
          const { listener } = await load();
          await listener(req, res);
        } catch (err) {
          server.ssrFixStacktrace(err as Error);
          console.error(err);
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
          res.end(String(err));
        }
      });
      api.listen(API_PORT, async () => {
        try {
          const { mode } = await load();
          const store = mode.store === 'notion' ? 'real Notion' : 'fake Notion (.data/fake-notion.json)';
          server.config.logger.info(`  ➜  API:     http://localhost:${API_PORT}/ · ${store}, ${mode.identity} sign-in`);
        } catch (err) {
          server.config.logger.error(`  ➜  API failed to start: ${(err as Error).message}`);
        }
      });
      server.httpServer?.on('close', () => api.close());
    },
  };
}

export default defineConfig({
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [devApi()],
  build: {
    // Library mode: one self-executing file that prototypes load with a <script> tag.
    lib: {
      entry: resolve(import.meta.dirname, 'src/index.ts'),
      name: 'PrototypeComments',
      formats: ['iife'],
      fileName: () => 'comments.js',
    },
    target: 'es2020',
    sourcemap: true,
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    open: '/demo/',
  },
  test: {
    environment: 'happy-dom',
  },
});
