// Deploys the backend to AWS Lambda behind a public Function URL, using the AWS CLI.
// Safe to re-run: creates what's missing, otherwise updates the code and settings.
//   npm run lambda:deploy                          build, then create or update
//   npm run lambda:deploy -- --rotate-session      also replace SESSION_SECRET (signs everyone out)
//
// Settings come from lambda.config.json; NOTION_TOKEN, NOTION_CLIENT_ID and NOTION_CLIENT_SECRET from .env.
// SESSION_SECRET is generated on the first deploy and kept on later ones. Secrets go to AWS through a
// temporary file only this user can read, never on the command line or in the output.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const config = JSON.parse(readFileSync('lambda.config.json', 'utf8'));
const rotateSession = process.argv.includes('--rotate-session');
if (existsSync('.env')) process.loadEnvFile('.env');

const SECRETS = ['NOTION_TOKEN', 'NOTION_CLIENT_ID', 'NOTION_CLIENT_SECRET'];
const missing = SECRETS.filter((k) => !process.env[k]);
if (missing.length) fail(`Missing in .env: ${missing.join(', ')}`);

const tmp = mkdtempSync(join(tmpdir(), 'pc-lambda-'));
try {
  run('npm', ['run', 'build:server']);
  const zip = join(tmp, 'lambda.zip');
  // lambda.mjs imports the code it shares with local.mjs from assets/, so ship both.
  run('zip', ['-r', '-q', zip, 'lambda.mjs', 'lambda.mjs.map', 'assets'], 'server/dist');

  const identity = aws(['sts', 'get-caller-identity']);
  console.log(`AWS account ${identity.Account}, region ${config.region}`);

  const roleArn = ensureRole();
  const existing = aws(['lambda', 'get-function-configuration', '--function-name', config.functionName], { allowMissing: true });
  const environment = { Variables: environmentFor(existing) };
  const settings = {
    FunctionName: config.functionName,
    Role: roleArn,
    Handler: 'lambda.handler',
    Runtime: 'nodejs22.x',
    MemorySize: config.memoryMb,
    Timeout: config.timeoutSeconds,
    Environment: environment,
  };

  if (!existing) {
    console.log(`Creating function ${config.functionName}…`);
    // A new role can take a few seconds before Lambda is allowed to use it.
    retry(() => aws(['lambda', 'create-function', '--cli-input-json', secretFile({ ...settings, Architectures: ['arm64'] }), '--zip-file', `fileb://${zip}`]));
    aws(['lambda', 'wait', 'function-active-v2', '--function-name', config.functionName], { json: false });
  } else {
    console.log(`Updating function ${config.functionName}…`);
    aws(['lambda', 'update-function-code', '--function-name', config.functionName, '--zip-file', `fileb://${zip}`]);
    aws(['lambda', 'wait', 'function-updated-v2', '--function-name', config.functionName], { json: false });
    aws(['lambda', 'update-function-configuration', '--cli-input-json', secretFile(settings)]);
    aws(['lambda', 'wait', 'function-updated-v2', '--function-name', config.functionName], { json: false });
  }

  const url = ensureFunctionUrl().replace(/\/$/, '');
  const health = await fetch(`${url}/health`).then((r) => r.json()).catch((err) => ({ error: String(err) }));
  console.log(`\nBackend: ${url}`);
  console.log(`Health:  ${JSON.stringify(health)}`);
  console.log(`\nUse it as data-endpoint, and add this redirect URI to the Notion OAuth connection:\n  ${url}/auth/callback`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

function environmentFor(existing) {
  const current = existing?.Environment?.Variables ?? {};
  let sessionSecret = current.SESSION_SECRET;
  if (!sessionSecret || rotateSession) {
    sessionSecret = randomBytes(32).toString('base64url');
    console.log(existing ? 'Rotating SESSION_SECRET: everyone will need to sign in again.' : 'Generated a SESSION_SECRET.');
  }
  return {
    NODE_OPTIONS: '--enable-source-maps',
    ...Object.fromEntries(Object.entries(config.vars).filter(([, v]) => v !== '')),
    ...Object.fromEntries(SECRETS.map((k) => [k, process.env[k]])),
    ...(process.env.SESSION_DAYS ? { SESSION_DAYS: process.env.SESSION_DAYS } : {}),
    SESSION_SECRET: sessionSecret,
  };
}

function ensureRole() {
  const found = aws(['iam', 'get-role', '--role-name', config.roleName], { allowMissing: true });
  if (found) return found.Role.Arn;
  console.log(`Creating IAM role ${config.roleName} (CloudWatch logs only)…`);
  const trust = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] };
  const role = aws(['iam', 'create-role', '--role-name', config.roleName, '--assume-role-policy-document', JSON.stringify(trust)]);
  aws(['iam', 'attach-role-policy', '--role-name', config.roleName, '--policy-arn', 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'], { json: false });
  return role.Role.Arn;
}

function ensureFunctionUrl() {
  const found = aws(['lambda', 'get-function-url-config', '--function-name', config.functionName], { allowMissing: true });
  if (found) return found.FunctionUrl;
  console.log('Creating a public Function URL…');
  // No CORS settings here: the handler sends its own CORS headers, checked against ALLOWED_ORIGINS.
  const created = aws(['lambda', 'create-function-url-config', '--function-name', config.functionName, '--auth-type', 'NONE']);
  const fn = ['--function-name', config.functionName, '--principal', '*'];
  aws(['lambda', 'add-permission', ...fn, '--statement-id', 'public-function-url', '--action', 'lambda:InvokeFunctionUrl', '--function-url-auth-type', 'NONE'], { allowConflict: true });
  aws(['lambda', 'add-permission', ...fn, '--statement-id', 'public-function-url-invoke', '--action', 'lambda:InvokeFunction', '--invoked-via-function-url'], { allowConflict: true });
  return created.FunctionUrl;
}

/** Writes request JSON that contains secrets to a private temp file, for --cli-input-json. */
function secretFile(data) {
  const file = join(tmp, `input-${randomBytes(4).toString('hex')}.json`);
  writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  return `file://${file}`;
}

function aws(args, { allowMissing = false, allowConflict = false, json = true } = {}) {
  const result = spawnSync('aws', [...args, '--region', config.region, ...(json ? ['--output', 'json'] : [])], { encoding: 'utf8' });
  if (result.error) fail(`Couldn't run the AWS CLI: ${result.error.message}`);
  if (result.status !== 0) {
    if (allowMissing && /NoSuchEntity|ResourceNotFoundException/.test(result.stderr)) return null;
    if (allowConflict && /ResourceConflictException/.test(result.stderr)) return null;
    const err = new Error(`aws ${args.slice(0, 2).join(' ')} failed:\n${result.stderr.trim()}`);
    err.stderr = result.stderr;
    throw err;
  }
  // Responses from create/update/get-function-configuration include the environment, so they're
  // parsed and never printed.
  return json && result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function retry(fn, attempts = 6) {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (err) {
      if (i >= attempts || !/cannot be assumed|InvalidParameterValueException/.test(err.stderr ?? '')) throw err;
      execFileSync('sleep', ['5']);
    }
  }
}

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', cwd });
  if (result.status !== 0) fail(`${cmd} ${args.join(' ')} failed`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
