import { createHandler, type AppConfig } from './handler';
import type { Handler } from './http';
import { fakeIdentity, notionIdentity } from './identity';
import type { Identity, Workspace } from './ports';
import { FAKE_USERS, MemoryWorkspace } from './stores/memory';
import { NotionWorkspace } from './stores/notion';

type Env = Record<string, string | undefined>;

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export interface BuildOptions {
  /** Allow fake Notion and a default session secret. Only for local development. */
  dev?: boolean;
  /** Where fake Notion persists its data in dev. */
  fakeDataFile?: string;
}

export interface BuiltApp {
  handler: Handler;
  mode: { store: 'notion' | 'fake'; identity: 'notion' | 'fake' };
}

/** Builds the handler from environment variables. See .env.example for what each one does. */
export function buildApp(env: Env, { dev = false, fakeDataFile }: BuildOptions = {}): BuiltApp {
  const missing = (name: string) => {
    throw new Error(`${name} is not set. See .env.example.`);
  };

  let workspace: Workspace;
  if (env.NOTION_TOKEN && env.NOTION_HUB_PAGE_ID) {
    workspace = new NotionWorkspace({ token: env.NOTION_TOKEN, hubPageId: env.NOTION_HUB_PAGE_ID });
  } else if (dev) {
    workspace = new MemoryWorkspace(FAKE_USERS, fakeDataFile);
  } else {
    missing(env.NOTION_TOKEN ? 'NOTION_HUB_PAGE_ID' : 'NOTION_TOKEN');
  }

  let identity: Identity;
  if (env.NOTION_CLIENT_ID && env.NOTION_CLIENT_SECRET) {
    identity = notionIdentity(env.NOTION_CLIENT_ID, env.NOTION_CLIENT_SECRET);
  } else if (dev) {
    // Fake sign-in only makes sense against fake data: real Notion needs real user ids.
    if (workspace! instanceof NotionWorkspace) missing('NOTION_CLIENT_ID / NOTION_CLIENT_SECRET (needed with a real NOTION_TOKEN)');
    identity = fakeIdentity(FAKE_USERS);
  } else {
    missing('NOTION_CLIENT_ID');
  }

  const sessionSecret = env.SESSION_SECRET || (dev ? 'dev-only-session-secret' : missing('SESSION_SECRET'));
  if (sessionSecret.length < 16) throw new Error('SESSION_SECRET must be at least 16 characters');

  const config: AppConfig = {
    sessionSecret,
    allowedOrigins: list(env.ALLOWED_ORIGINS ?? (dev ? 'http://localhost:5173,http://localhost:4173' : '')),
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
