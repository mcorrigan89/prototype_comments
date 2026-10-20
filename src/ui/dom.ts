import type { User } from '../types';
import { escapeRegExp } from '../util';

type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown> & { class?: string; style?: Partial<CSSStyleDeclaration> };

/** Tiny hyperscript helper: h('button', { class: 'x', onClick }, 'Label'). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = String(value);
      else if (key === 'style') Object.assign(el.style, value);
      else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

function hue(seed: string): number {
  let n = 0;
  for (const ch of seed) n = (n * 31 + ch.codePointAt(0)!) % 360;
  return n;
}

export function initials(name: string | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0][0];
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

export function avatar(user: User | null | undefined, size = 24): HTMLElement {
  const el = h('span', {
    class: 'avatar',
    title: user?.name,
    style: {
      width: `${size}px`,
      height: `${size}px`,
      fontSize: `${Math.round(size * 0.4)}px`,
      background: `hsl(${hue(user?.id ?? user?.name ?? '?')} 58% 46%)`,
    },
  });
  if (user?.avatarUrl) el.append(h('img', { src: user.avatarUrl, alt: '' }));
  else el.textContent = initials(user?.name);
  return el;
}

/** Comment text with @mentions highlighted. Never uses innerHTML. */
export function renderBody(body: string, mentions: User[] | undefined): DocumentFragment {
  const frag = document.createDocumentFragment();
  const names = [...new Set((mentions ?? []).map((m) => m.name).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!names.length) {
    frag.append(body);
    return frag;
  }
  const re = new RegExp(`@(?:${names.map(escapeRegExp).join('|')})`, 'g');
  let last = 0;
  for (const match of body.matchAll(re)) {
    frag.append(body.slice(last, match.index), h('span', { class: 'mention' }, match[0]));
    last = match.index + match[0].length;
  }
  frag.append(body.slice(last));
  return frag;
}
