/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
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
    open: '/demo/',
  },
  test: {
    environment: 'happy-dom',
  },
});
