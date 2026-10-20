export const LOG = '[prototype-comments]';

export function uid(): string {
  // randomUUID is only exposed in secure contexts; S3 website endpoints are plain http.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const rand = () => Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${rand()}-${rand()}`;
}

export const nowIso = () => new Date().toISOString();

export const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);

export const round4 = (n: number) => Math.round(n * 10000) / 10000;

export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

export const THREAD_PARAM = 'pc-thread';

/** Pulls the 32-hex Notion id out of a link or id; null if there isn't one. */
export function notionIdFrom(ref: string): string | null {
  const path = ref.split(/[?#]/)[0].replace(/-/g, '');
  const match = path.match(/[0-9a-f]{32}$/i) ?? path.match(/[0-9a-f]{32}/i);
  return match ? match[0].toLowerCase() : null;
}

/** Normalised key for "which screen of the prototype is this". */
export function pageKeyFor(mode: 'path' | 'path+hash', loc: Location | URL = location): string {
  const path = loc.pathname.replace(/\/index\.html?$/i, '/') || '/';
  return mode === 'path+hash' ? path + loc.hash : path;
}

/** Current URL without our own deep-link parameter. */
export function cleanUrl(href: string = location.href): string {
  const url = new URL(href);
  url.searchParams.delete(THREAD_PARAM);
  return url.toString();
}

export function withThreadParam(href: string, threadId: string): string {
  const url = new URL(href, location.href);
  url.searchParams.set(THREAD_PARAM, threadId);
  return url.toString();
}
