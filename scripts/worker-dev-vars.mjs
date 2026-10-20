// Writes .dev.vars for `npm run worker:dev`: your .env, plus local origins and a
// throwaway session secret, so the Worker runs locally exactly as it would deployed.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const env = existsSync('.env') ? Object.fromEntries(readFileSync('.env', 'utf8').split('\n').filter((l) => /^[A-Z_]+=./.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])) : {};
env.ALLOWED_ORIGINS ||= 'http://localhost:5173,http://localhost:4173';
env.SESSION_SECRET ||= randomBytes(32).toString('base64url');
writeFileSync('.dev.vars', Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
console.log(`.dev.vars written (${Object.keys(env).join(', ')})`);
