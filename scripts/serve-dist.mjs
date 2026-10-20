// Serves the demo using the *built* dist/comments.js as a classic <script defer>,
// exactly how a prototype on S3 would load it, plus the built backend on :8787.
// Run via `npm run preview`.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
process.chdir(root);
await import('../server/dist/local.mjs');
const port = Number(process.env.PORT) || 4173;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.json': 'application/json' };

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/') path = '/demo/';
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(root, path));
  if (!file.startsWith(root + '/demo/') && !file.startsWith(root + '/dist/')) {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    let body = await readFile(file);
    if (extname(file) === '.html') {
      body = body
        .toString()
        .replace('<script type="module" src="/src/index.ts"', '<script src="/dist/comments.js" defer');
    }
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, () => console.log(`Built demo: http://localhost:${port}/demo/`));
