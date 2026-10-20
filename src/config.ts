import type { Config, User } from './types';
import { notionIdFrom } from './util';

/** Options can also be set before the script loads: window.PrototypeComments = { users: [...] } */
export type PreConfig = Partial<Config>;

/**
 * Finds the <script> tag that loaded us. document.currentScript covers the built
 * file; the selector fallback covers `type="module"` in dev, where currentScript is null.
 */
export function findScriptTag(): HTMLScriptElement | null {
  const current = document.currentScript;
  if (current instanceof HTMLScriptElement) return current;
  return document.querySelector<HTMLScriptElement>('script[data-prototype-comments], script[data-notion], script[data-project]');
}

function parseUsers(value: unknown): User[] {
  if (!Array.isArray(value)) return [];
  return value.filter((u): u is User => !!u && typeof u.name === 'string').map((u) => ({ ...u, id: u.id ?? u.name }));
}

export function readConfig(pre: PreConfig = {}, script: HTMLScriptElement | null = findScriptTag()): Config {
  const data = script?.dataset ?? {};
  const notion = data.notion || pre.notion || undefined;
  return {
    // With a Notion database, that database *is* the project.
    project: data.project || pre.project || (notion && (notionIdFrom(notion) ?? notion)) || location.hostname || 'local-file',
    storage: data.storage || pre.storage || (notion ? 'remote' : 'local'),
    pageKey: (data.pageKey || pre.pageKey) === 'path+hash' ? 'path+hash' : 'path',
    users: parseUsers(pre.users),
    shortcuts: (data.shortcuts ?? String(pre.shortcuts ?? true)) !== 'false',
    endpoint: data.endpoint || pre.endpoint,
    notion,
    toolbar: data.toolbar || pre.toolbar,
  };
}
