import type { User } from '../../src/types';
import type { Identity } from './ports';
import { NOTION_API } from './stores/notion';

/**
 * "Sign in with Notion", used only to learn who someone is. The access token
 * Notion returns is thrown away; all reads and writes use the internal integration.
 */
export function notionIdentity(clientId: string, clientSecret: string, fetchImpl: typeof fetch = fetch): Identity {
  return {
    kind: 'notion',
    authorizeUrl(state, redirectUri) {
      const params = new URLSearchParams({ client_id: clientId, response_type: 'code', owner: 'user', redirect_uri: redirectUri, state });
      return `${NOTION_API}/oauth/authorize?${params}`;
    },
    async exchange(code, redirectUri) {
      const res = await fetchImpl(`${NOTION_API}/oauth/token`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
      });
      const data = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new Error(`Notion token exchange failed: ${res.status} ${data.error ?? ''} ${data.error_description ?? ''}`);
      const user = data.owner?.user;
      if (data.owner?.type !== 'user' || !user?.id) throw new Error('Notion sign-in did not return a person');
      return {
        id: user.id,
        name: user.name || 'Unknown',
        ...(user.avatar_url ? { avatarUrl: user.avatar_url } : {}),
        ...(user.person?.email ? { email: user.person.email } : {}),
      } satisfies User;
    },
  };
}

/** Local development: a "pick a user" page served by the handler at /auth/fake. */
export function fakeIdentity(users: User[]): Identity {
  return {
    kind: 'fake',
    authorizeUrl(state, redirectUri) {
      return `${redirectUri.replace(/\/auth\/callback$/, '/auth/fake')}?${new URLSearchParams({ state })}`;
    },
    async exchange(code) {
      const user = users.find((u) => u.id === code);
      if (!user) throw new Error(`Unknown fake user ${code}`);
      return user;
    },
  };
}
