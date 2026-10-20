/**
 * Creates a feedback database for one prototype, inside the hub page, with the
 * columns the backend expects, and prints the <script> tag to paste into the
 * prototype's <head>.
 *
 *   npm run notion:setup -- "Checkout v2"
 *
 * Needs NOTION_TOKEN and NOTION_HUB_PAGE_ID in .env. The integration must be
 * connected to the hub page (page menu → Connections), which also gives it every
 * database created inside.
 *
 * (Duplicating an existing feedback database in Notion works just as well.)
 *
 * Runs directly on Node's built-in TypeScript support, so it has no imports from src/.
 */
import { existsSync } from 'node:fs';

const NOTION_VERSION = '2026-03-11';

if (existsSync('.env')) process.loadEnvFile('.env');
const token = process.env.NOTION_TOKEN;
const hub = process.env.NOTION_HUB_PAGE_ID;
const name = process.argv.slice(2).join(' ').trim();

if (!token || !hub || !name) {
  console.error('Usage: npm run notion:setup -- "<prototype name>"   (with NOTION_TOKEN and NOTION_HUB_PAGE_ID in .env)');
  process.exit(1);
}

// Accepts a page URL ("…/My-Page-1a2b3c…?pvs=4") or a bare id. Same rule as src/util.ts notionIdFrom.
const path = hub.split(/[?#]/)[0].replace(/-/g, '');
const parentId = (path.match(/[0-9a-f]{32}$/i) ?? path.match(/[0-9a-f]{32}/i))?.[0];
if (!parentId) {
  console.error(`Couldn't find a page id in NOTION_HUB_PAGE_ID ("${hub}")`);
  process.exit(1);
}

const properties = {
  Feedback: { title: {} },
  Status: {
    select: {
      options: [
        { name: 'Open', color: 'yellow' },
        { name: 'Resolved', color: 'green' },
      ],
    },
  },
  Reviewer: { people: {} },
  Mentioned: { people: {} },
  'Resolved by': { people: {} },
  Page: { rich_text: {} },
  Link: { url: {} },
  'Comment count': { number: { format: 'number' } },
  Pin: { rich_text: {} },
  'Client ID': { rich_text: {} },
};

const res = await fetch('https://api.notion.com/v1/databases', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'notion-version': NOTION_VERSION, 'content-type': 'application/json' },
  body: JSON.stringify({
    parent: { type: 'page_id', page_id: parentId },
    title: [{ type: 'text', text: { content: `${name} · Feedback` } }],
    icon: { type: 'emoji', emoji: '💬' },
    initial_data_source: { properties },
  }),
});
const data = (await res.json()) as any;
if (!res.ok) {
  console.error(`Notion said ${res.status}: ${data.message ?? JSON.stringify(data)}`);
  if (res.status === 404) console.error('Is the integration connected to the hub page? Page menu → Connections → add your integration.');
  process.exit(1);
}

console.log(`Created "${name} · Feedback": ${data.url}\n`);
console.log('Paste this into the prototype’s <head> (fill in where comments.js and the backend are hosted):\n');
console.log(`<script src="https://…/comments.js" data-notion="${data.url}" data-endpoint="https://…" defer></script>`);
