import type { User } from '../types';
import { LOG } from '../util';
import { avatar, h } from './dom';
import { icon } from './icons';

export interface ComposerOptions {
  placeholder: string;
  initialValue: string;
  getUsers: () => User[];
  onChange: (value: string) => void;
  onSubmit: (body: string, mentions: User[]) => Promise<void>;
  onCancel: () => void;
  onError: (message: string) => void;
}

export interface Composer {
  el: HTMLElement;
  textarea: HTMLTextAreaElement;
  focus(): void;
}

const MAX_SUGGESTIONS = 8;

/** Keeps keystrokes inside the composer from reaching the prototype's own shortcuts. */
const stop = (e: Event) => e.stopPropagation();

export function createComposer(opts: ComposerOptions): Composer {
  const textarea = h('textarea', { rows: 1, placeholder: opts.placeholder, 'aria-label': opts.placeholder });
  textarea.value = opts.initialValue;
  const send = h('button', { class: 'send', type: 'button', title: 'Post (Enter)', 'aria-label': 'Post comment' }, icon('send'));
  const list = h('div', { class: 'mention-list', role: 'listbox', hidden: true });
  const el = h('div', { class: 'composer' }, textarea, send, list);

  let suggestions: User[] = [];
  let selected = 0;
  let query: { text: string; start: number } | null = null;
  let busy = false;

  const autosize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  };
  const syncButton = () => {
    send.disabled = busy || !textarea.value.trim();
  };

  /** The "@query" immediately before the caret, if any. */
  function currentQuery() {
    const before = textarea.value.slice(0, textarea.selectionStart);
    const match = /(?:^|\s)@([^\s@]{0,40})$/.exec(before);
    return match ? { text: match[1].toLowerCase(), start: before.length - match[1].length - 1 } : null;
  }

  function hideList() {
    list.hidden = true;
    suggestions = [];
    selected = 0;
  }

  function renderList() {
    query = currentQuery();
    if (!query) return hideList();
    const q = query.text;
    suggestions = opts
      .getUsers()
      .filter((u) => u.name.toLowerCase().includes(q) || (u.email ?? '').toLowerCase().includes(q))
      .slice(0, MAX_SUGGESTIONS);
    if (!suggestions.length) return hideList();
    selected = Math.min(selected, suggestions.length - 1);
    list.replaceChildren(
      ...suggestions.map((user, i) =>
        h(
          'button',
          {
            class: `mention-item${i === selected ? ' sel' : ''}`,
            type: 'button',
            role: 'option',
            'aria-selected': String(i === selected),
            // mousedown so the textarea doesn't lose focus first
            onMouseDown: (e: MouseEvent) => {
              e.preventDefault();
              pick(i);
            },
          },
          avatar(user, 20),
          h('span', null, user.name),
          user.email ? h('span', { class: 'email' }, user.email) : null,
        ),
      ),
    );
    list.hidden = false;
  }

  function pick(index: number) {
    const user = suggestions[index];
    if (!user || !query) return;
    const before = textarea.value.slice(0, query.start);
    const after = textarea.value.slice(textarea.selectionStart);
    const insert = `@${user.name} `;
    textarea.value = before + insert + after;
    const caret = before.length + insert.length;
    textarea.setSelectionRange(caret, caret);
    textarea.focus();
    hideList();
    onInput();
  }

  function onInput() {
    opts.onChange(textarea.value);
    autosize();
    syncButton();
  }

  async function submit() {
    const body = textarea.value.trim();
    if (!body || busy) return;
    const seen = new Set<string>();
    const mentions = opts.getUsers().filter((u) => {
      if (seen.has(u.id) || !body.includes(`@${u.name}`)) return false;
      seen.add(u.id);
      return true;
    });
    busy = true;
    syncButton();
    try {
      await opts.onSubmit(body, mentions);
    } catch (err) {
      console.error(LOG, err);
      opts.onError('Couldn’t save your comment');
    } finally {
      busy = false;
      syncButton();
    }
  }

  textarea.addEventListener('input', () => {
    onInput();
    renderList();
  });
  textarea.addEventListener('click', renderList);
  textarea.addEventListener('blur', () => setTimeout(hideList, 120));
  textarea.addEventListener('keyup', stop);
  textarea.addEventListener('keypress', stop);
  textarea.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (!list.hidden && suggestions.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        selected = (selected + step + suggestions.length) % suggestions.length;
        renderList();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(selected);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hideList();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      opts.onCancel();
    }
  });
  send.addEventListener('click', () => void submit());

  syncButton();
  requestAnimationFrame(autosize);

  return {
    el,
    textarea,
    focus() {
      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    },
  };
}
