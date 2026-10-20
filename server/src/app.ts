import { createHandler, type AppConfig } from './handler';
import type { Handler } from './http';
import { fakeIdentity, notionIdentity } from './identity';
import type { Identity, Workspace } from './ports';
import { NotionWorkspace } from './stores/notion';

type Env = Record<string, string | undefined>;

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export interface BuildOptions {
  /** Allow fake Notion, pick-a-person sign-in and a default session secret. Only for local development. */
  dev?: boolean;
  /**
   * Fake Notion, used in dev when there's no NOTION_TOKEN. Passed in rather than
   * imported, so production bundles (Lambda, Workers) never include it or its file access.
   */
  fakeWorkspace?: () => Workspace;
}

export interface BuiltApp {
  handler: Handler;
  mode: { store: 'notion' | 'fake'; identity: 'notion' | 'fake' };
}

/** Builds the handler from environment variables. See .env.example for what each one does. */
export function buildApp(env: Env, { dev = false, fakeWorkspace }: BuildOptions = {}): BuiltApp {
  const missing = (name: string) => {
    throw new Error(`${name} is not set. See .env.example.`);
  };

  let workspace: Workspace;
  if (env.NOTION_TOKEN) {
    workspace = new NotionWorkspace({ token: env.NOTION_TOKEN });
  } else if (dev && fakeWorkspace) {
    workspace = fakeWorkspace();
  } else {
    missing('NOTION_TOKEN');
  }

  let identity: Identity;
  if (env.NOTION_CLIENT_ID && env.NOTION_CLIENT_SECRET) {
    identity = notionIdentity(env.NOTION_CLIENT_ID, env.NOTION_CLIENT_SECRET);
  } else if (dev) {
    // Pick-a-person sign-in. With real Notion it lists the workspace's real members,
    // so you can try everything with just the internal integration. Never in production.
    identity = fakeIdentity(() => workspace!.listUsers());
  } else {
    missing('NOTION_CLIENT_ID');
  }

  const sessionSecret = env.SESSION_SECRET || (dev ? 'dev-only-session-secret' : missing('SESSION_SECRET'));
  if (sessionSecret.length < 16) throw new Error('SESSION_SECRET must be at least 16 characters');

  const config: AppConfig = {
    sessionSecret,
    // `||`, not `??`: a blank line in .env (ALLOWED_ORIGINS=) means "not set".
    allowedOrigins: list(env.ALLOWED_ORIGINS || (dev ? 'http://localhost:5173,http://localhost:4173' : '')),
    privateDatabases: new Set(list(env.PRIVATE_DATABASES)),
    publicUrl: env.PUBLIC_URL || undefined,
    sessionDays: Number(env.SESSION_DAYS) || 30,
  };
  if (!config.allowedOrigins.length) missing('ALLOWED_ORIGINS');

  return {
    handler: createHandler({ workspace: workspace!, identity: identity!, config }),
    mode: { store: workspace! instanceof NotionWorkspace ? 'notion' : 'fake', identity: identity!.kind },
  };
}
