import type { Config, User } from './types';

/** Options can also be set before the script loads: window.PrototypeComments = { users: [...] } */
export type PreConfig = Partial<Config>;

/**
 * Finds the <script> tag that loaded us. document.currentScript covers the built
 * file; the selector fallback covers `type="module"` in dev, where currentScript is null.
 */
function findScriptTag(): HTMLScriptElement | null {
  const current = document.currentScript;
  if (current instanceof HTMLScriptElement) return current;
  return document.querySelector<HTMLScriptElement>('script[data-prototype-comments], script[data-project]');
}

function parseUsers(value: unknown): User[] {
  if (!Array.isArray(value)) return [];
  return value.filter((u): u is User => !!u && typeof u.name === 'string').map((u) => ({ ...u, id: u.id ?? u.name }));
}

export function readConfig(pre: PreConfig = {}, script: HTMLScriptElement | null = findScriptTag()): Config {
  const data = script?.dataset ?? {};
  return {
    project: data.project || pre.project || location.hostname || 'local-file',
    storage: data.storage || pre.storage || 'local',
    pageKey: (data.pageKey || pre.pageKey) === 'path+hash' ? 'path+hash' : 'path',
    users: parseUsers(pre.users),
    shortcuts: (data.shortcuts ?? String(pre.shortcuts ?? true)) !== 'false',
    endpoint: data.endpoint || pre.endpoint,
  };
}
