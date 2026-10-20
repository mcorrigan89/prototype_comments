// Uploads the backend's secrets from .env to the deployed Worker, without printing them.
//   npm run worker:secrets                                        all of them; generates SESSION_SECRET
//                                                                 if .env has none (that signs everyone out)
//   npm run worker:secrets -- NOTION_CLIENT_ID NOTION_CLIENT_SECRET   only these
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
const ALL = ['NOTION_TOKEN', 'NOTION_CLIENT_ID', 'NOTION_CLIENT_SECRET', 'SESSION_SECRET'];
const only = process.argv.slice(2);
const unknown = only.filter((k) => !ALL.includes(k));
if (unknown.length) {
  console.error(`Not a backend secret: ${unknown.join(', ')} (expected some of ${ALL.join(', ')})`);
  process.exit(1);
}
const keys = only.length ? only : ALL;
if (!process.env.SESSION_SECRET && keys.includes('SESSION_SECRET')) process.env.SESSION_SECRET = randomBytes(32).toString('base64url');
const missing = keys.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing in .env: ${missing.join(', ')}`);
  process.exit(1);
}
const secrets = Object.fromEntries(keys.map((k) => [k, process.env[k]]));

// `wrangler secret bulk` reads JSON from stdin, so the values never touch disk or the terminal.
const result = spawnSync('npx', ['wrangler', 'secret', 'bulk'], { input: JSON.stringify(secrets), stdio: ['pipe', 'inherit', 'inherit'] });
process.exit(result.status ?? 1);
