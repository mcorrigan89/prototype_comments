// Runs the built Lambda bundle (server/dist/lambda.mjs, exactly what lambda:deploy uploads) on
// localhost, turning each HTTP request into a Function URL event. Uses .env, plus local origins
// and a throwaway session secret.
//   npm run lambda:local          → http://localhost:8789
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

if (existsSync('.env')) process.loadEnvFile('.env');
process.env.ALLOWED_ORIGINS ||= 'http://localhost:5173,http://localhost:4173';
process.env.SESSION_SECRET ||= randomBytes(32).toString('base64url');
process.env.PUBLIC_URL = '';
const port = Number(process.env.LAMBDA_PORT) || 8789;

const { handler } = await import(pathToFileURL('server/dist/lambda.mjs').href);

createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const event = {
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    headers: { ...req.headers, 'x-forwarded-proto': 'http' },
    body: chunks.length ? Buffer.concat(chunks).toString('base64') : undefined,
    isBase64Encoded: chunks.length > 0,
    requestContext: { http: { method: req.method } },
  };
  try {
    const result = await handler(event);
    res.writeHead(result.statusCode, result.headers).end(result.body);
  } catch (err) {
    console.error(err);
    res.writeHead(500).end('Lambda handler threw; see the terminal');
  }
}).listen(port, () => console.log(`  ➜  Lambda bundle: http://localhost:${port}/  (sign-in needs http://localhost:${port}/auth/callback on the OAuth connection)`));
