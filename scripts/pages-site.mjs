// Assembles the GitHub Pages site from the client build: the latest comments.js
// at the root, a pinned copy under v<version>/, and a small index page.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
rmSync('site', { recursive: true, force: true });
mkdirSync(`site/v${version}`, { recursive: true });
for (const file of ['comments.js', 'comments.js.map']) {
  cpSync(`dist/${file}`, `site/${file}`);
  cpSync(`dist/${file}`, `site/v${version}/${file}`);
}

const base = 'https://mcorrigan89.github.io/prototype_comments';
writeFileSync(
  'site/index.html',
  `<!doctype html><meta charset="utf-8"><title>Prototype Comments</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:680px;margin:48px auto;padding:0 16px}code,pre{background:#f4f4f5;border-radius:6px}pre{padding:12px;overflow:auto}</style>
<h1>Prototype Comments</h1>
<p>Add to a prototype's <code>&lt;head&gt;</code>:</p>
<pre>&lt;script src="${base}/comments.js"
        data-notion="https://app.notion.com/p/…"
        data-endpoint="https://…"
        defer&gt;&lt;/script&gt;</pre>
<p>Latest: <a href="comments.js">comments.js</a> · This version (${version}), never changes: <a href="v${version}/comments.js">v${version}/comments.js</a></p>
<p><a href="https://github.com/mcorrigan89/prototype_comments">Source and docs</a></p>
`,
);
console.log(`site/ ready: comments.js and v${version}/comments.js`);
