// Uploads the backend's secrets from .env to the deployed Worker, without printing them.
// Generates SESSION_SECRET if .env doesn't have one (it only needs to live in Cloudflare).
//   npm run worker:secrets
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
const required = ['NOTION_TOKEN', 'NOTION_CLIENT_ID', 'NOTION_CLIENT_SECRET'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing in .env: ${missing.join(', ')}`);
  process.exit(1);
}
const secrets = Object.fromEntries(required.map((k) => [k, process.env[k]]));
secrets.SESSION_SECRET = process.env.SESSION_SECRET || randomBytes(32).toString('base64url');

// `wrangler secret bulk` reads JSON from stdin, so the values never touch disk or the terminal.
const result = spawnSync('npx', ['wrangler', 'secret', 'bulk'], { input: JSON.stringify(secrets), stdio: ['pipe', 'inherit', 'inherit'] });
process.exit(result.status ?? 1);
