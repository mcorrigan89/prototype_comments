import type { Thread } from '../types';
import { timeAgo } from '../util';
import type { App, Filter, Scope } from './app';
import { avatar, h, renderBody } from './dom';
import { icon } from './icons';

export interface Sidebar {
  el: HTMLElement;
  render(): void;
}

const SCOPES: [Scope, string][] = [
  ['page', 'This page'],
  ['all', 'All pages'],
];
const FILTERS: [Filter, string][] = [
  ['open', 'Open'],
  ['resolved', 'Resolved'],
  ['all', 'All'],
];

export function createSidebar(app: App): Sidebar {
  const scopeSeg = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Which pages' });
  const filterSeg = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Status' });
  const list = h('div', { class: 'sb-list' });

  const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) void app.importJson(file);
  });

  const storageLabel = h('span', { class: 'grow' });
  const foot = h(
    'div',
    { class: 'sb-foot' },
    storageLabel,
    app.store.exportData
      ? h('button', { class: 'text-btn', type: 'button', title: 'Download all comments as JSON', onClick: () => void app.exportJson() }, icon('download', 14), 'Export')
      : null,
    app.store.importData
      ? h('button', { class: 'text-btn', type: 'button', title: 'Import comments from a JSON export', onClick: () => fileInput.click() }, icon('upload', 14), 'Import')
      : null,
    fileInput,
  );

  const el = h(
    'aside',
    { class: 'sidebar', 'aria-label': 'Comments' },
    h(
      'div',
      { class: 'sb-head' },
      h('div', { class: 'sb-title' }, 'Comments'),
      h('button', { class: 'icon-btn', type: 'button', title: 'Close', 'aria-label': 'Close comments', onClick: () => app.setSidebar(false) }, icon('close')),
    ),
    h('div', { class: 'sb-controls' }, scopeSeg, filterSeg),
    list,
    foot,
  );

  function item(t: Thread): HTMLElement {
    const { state } = app;
    const first = t.comments[0];
    const replies = t.comments.length - 1;
    const onPage = t.page === state.page;
    const hidden = onPage && !app.locate(t.id, t.pin);
    return h(
      'button',
      { class: `sb-item${t.id === state.activeId ? ' active' : ''}`, type: 'button', onClick: () => app.goToThread(t) },
      h(
        'div',
        { class: 'row' },
        avatar(t.createdBy, 24),
        h('span', { class: 'name' }, t.createdBy?.name ?? 'Unknown'),
        h('span', { class: 'time' }, timeAgo(t.updatedAt || t.createdAt)),
        t.status === 'resolved' ? h('span', { class: 'tag ok' }, 'Resolved') : null,
      ),
      h('div', { class: 'preview' }, renderBody(first?.body ?? '', first?.mentions)),
      h(
        'div',
        { class: 'sub' },
        replies > 0 ? h('span', null, `${replies} ${replies === 1 ? 'reply' : 'replies'}`) : null,
        state.scope === 'all' ? h('span', { class: 'tag' }, t.page) : null,
        hidden ? h('span', { class: 'tag warn', title: 'The element it’s pinned to isn’t on screen right now' }, 'Not visible') : null,
      ),
    );
  }

  function render() {
    const { state } = app;
    el.classList.toggle('open', state.sidebarOpen);
    if (!state.sidebarOpen) return;

    const inScope = state.threads.filter((t) => state.scope === 'all' || t.page === state.page);
    const counts: Record<Filter, number> = {
      open: inScope.filter((t) => t.status === 'open').length,
      resolved: inScope.filter((t) => t.status === 'resolved').length,
      all: inScope.length,
    };

    scopeSeg.replaceChildren(
      ...SCOPES.map(([value, label]) =>
        h('button', { class: state.scope === value ? 'on' : '', type: 'button', role: 'tab', 'aria-selected': String(state.scope === value), onClick: () => app.setScope(value) }, label),
      ),
    );
    filterSeg.replaceChildren(
      ...FILTERS.map(([value, label]) =>
        h(
          'button',
          { class: state.filter === value ? 'on' : '', type: 'button', role: 'tab', 'aria-selected': String(state.filter === value), onClick: () => app.setFilter(value) },
          label,
          h('span', { class: 'n' }, String(counts[value])),
        ),
      ),
    );

    const threads = inScope.filter((t) => app.matchesFilter(t)).sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
    if (threads.length) {
      list.replaceChildren(...threads.map(item));
    } else {
      const what = state.filter === 'all' ? '' : `${state.filter} `;
      list.replaceChildren(
        h(
          'div',
          { class: 'sb-empty' },
          h('strong', null, `No ${what}comments ${state.scope === 'page' ? 'on this page' : 'yet'}`),
          'Press C or use the comment button, then click anywhere on the prototype.',
        ),
      );
    }
    storageLabel.textContent = app.store.label;
  }

  return { el, render };
}
