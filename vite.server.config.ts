import { defineConfig } from 'vite';

/** Bundles the backend into self-contained ES modules for Lambda (and local preview). */
export default defineConfig({
  build: {
    ssr: true,
    outDir: 'server/dist',
    target: 'node22',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        lambda: 'server/src/lambda.ts',
        local: 'server/src/local.ts',
      },
      // .mjs for shared chunks too: Lambda has no package.json "type": "module", so .js would load as CommonJS.
      output: { format: 'es', entryFileNames: '[name].mjs', chunkFileNames: 'assets/[name]-[hash].mjs' },
    },
  },
  ssr: {
    // No dependencies to install on Lambda: everything goes in the bundle.
    noExternal: true,
  },
});
