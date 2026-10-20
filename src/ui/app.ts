import { makePin, pointFor, resolveElement, type Point } from '../anchor';
import type { Config, Pin, StorageAdapter, Thread, User } from '../types';
import { LOG, THREAD_PARAM, clamp, cleanUrl, pageKeyFor, timeAgo, withThreadParam } from '../util';
import { createComposer } from './composer';
import { avatar, h, renderBody } from './dom';
import { COMMENT_CURSOR, icon } from './icons';
import { promptForName, promptForSignIn } from './modal';
import {
  DEFAULT_TOOLBAR_POSITION,
  isToolbarPosition,
  loadToolbarPosition,
  makeDraggable,
  saveToolbarPosition,
  stepPosition,
  type ToolbarPosition,
} from './toolbar-position';
import { createSidebar, type Sidebar } from './sidebar';
import css from './styles.css?inline';

const PIN_SIZE = 32;
const SIDEBAR_WIDTH = 340;
const GAP = 12;
/** How often (in frames) cached pin elements are re-resolved, to catch DOM changes. */
const RESOLVE_EVERY = 30;
const DRAFT_ID = '__draft__';
const NEW_DRAFT_KEY = 'new';
/** Events swallowed in comment mode so clicks don't operate the prototype. */
const BLOCKED_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu'];

export type Scope = 'page' | 'all';
export type Filter = 'open' | 'resolved' | 'all';

interface State {
  threads: Thread[];
  users: User[];
  user: User | null;
  page: string;
  placing: boolean;
  pinsVisible: boolean;
  sidebarOpen: boolean;
  scope: Scope;
  filter: Filter;
  activeId: string | null;
  draft: { pin: Pin } | null;
  hoverEl: Element | null;
  modalOpen: boolean;
  toolbarPosition: ToolbarPosition;
}

export class App {
  readonly state: State;
  readonly host: HTMLElement;
  private readonly shadow: ShadowRoot;
  private readonly root: HTMLElement;

  private readonly layer: HTMLElement;
  private readonly highlight: HTMLElement;
  private readonly popover: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly toastEl: HTMLElement;
  private readonly toolbar: ReturnType<App['buildToolbar']>;
  private readonly sidebar: Sidebar;

  private readonly pinEls = new Map<string, HTMLButtonElement>();
  private draftPin: HTMLButtonElement | null = null;
  private readonly resolved = new Map<string, { el: Element | null; frame: number }>();
  /** Unsent composer text, keyed by thread id (or NEW_DRAFT_KEY). Survives re-renders. */
  private readonly drafts = new Map<string, string>();
  private frame = 0;
  private toastTimer = 0;

  constructor(
    readonly config: Config,
    readonly store: StorageAdapter,
  ) {
    this.state = {
      threads: [],
      users: [],
      user: null,
      page: pageKeyFor(config.pageKey),
      placing: false,
      pinsVisible: true,
      sidebarOpen: false,
      scope: 'page',
      filter: 'open',
      activeId: null,
      draft: null,
      hoverEl: null,
      modalOpen: false,
      toolbarPosition: loadToolbarPosition() ?? (isToolbarPosition(config.toolbar) ? config.toolbar : DEFAULT_TOOLBAR_POSITION),
    };

    this.host = document.createElement('pc-overlay');
    this.host.setAttribute('data-prototype-comments', '');
    this.host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;display:block;';
    this.shadow = this.host.attachShadow({ mode: 'open' });
    this.shadow.append(h('style', null, css));

    this.layer = h('div', { class: 'layer' });
    this.highlight = h('div', { class: 'highlight', hidden: true });
    this.layer.append(this.highlight);
    this.popover = h('div', { class: 'popover', hidden: true, role: 'dialog' });
    this.hint = h('div', { class: 'hint' }, 'Click anywhere to leave a comment · Esc to exit');
    this.toastEl = h('div', { class: 'toast', role: 'status' });
    this.toolbar = this.buildToolbar();
    this.sidebar = createSidebar(this);

    // DOM order is stacking order: pins < sidebar < popover < toolbar < hint < modal < toast.
    this.root = h('div', { class: 'root' }, this.layer, this.sidebar.el, this.popover, this.toolbar.el, this.hint);
    this.shadow.append(this.root);
  }

  async mount() {
    // Appended to <html> rather than <body> so apps that re-render <body> don't remove it.
    document.documentElement.append(this.host);
    this.root.append(this.toastEl);
    this.injectPageStyles();
    this.bindPageEvents();
    this.watchNavigation();

    await this.refresh();
    this.store.subscribe(() => void this.refresh());
    this.openFromUrl();

    // Relative timestamps in the sidebar.
    setInterval(() => this.sidebar.render(), 60_000);
    requestAnimationFrame(this.tick);
  }

  // ---------- Data ----------

  async refresh() {
    try {
      const [threads, users, user] = await Promise.all([this.store.listThreads(), this.store.listUsers(), this.store.getCurrentUser()]);
      this.state.threads = threads.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      this.state.users = users;
      this.state.user = user;
    } catch (err) {
      console.error(LOG, err);
      this.toast('Couldn’t load comments');
    }
    if (this.state.activeId && !this.thread(this.state.activeId)) this.state.activeId = null;
    this.render();
    const notice = this.store.takeNotice?.();
    if (notice) this.toast(notice);
  }

  thread(id: string): Thread | undefined {
    return this.state.threads.find((t) => t.id === id);
  }

  matchesFilter(t: Thread): boolean {
    return this.state.filter === 'all' || t.status === this.state.filter;
  }

  pageThreads(): Thread[] {
    return this.state.threads.filter((t) => t.page === this.state.page);
  }

  isMine(user: User | undefined): boolean {
    return !!user && !!this.state.user && user.id === this.state.user.id;
  }

  /** Remote storage may know there are more comments than it has loaded. */
  commentCount(t: Thread): number {
    return Math.max(t.commentCount ?? 0, t.comments.length);
  }

  // ---------- Actions ----------

  async ensureUser(): Promise<boolean> {
    if (this.state.user) return true;
    return this.store.auth === 'signin' ? this.askSignIn() : this.askName();
  }

  async askSignIn(): Promise<boolean> {
    const { signIn } = this.store;
    if (this.state.modalOpen || !signIn) return false;
    this.state.modalOpen = true;
    const user = await promptForSignIn({
      container: this.root,
      signIn: () => signIn.call(this.store),
      cancel: () => this.store.cancelSignIn?.(),
    });
    this.state.modalOpen = false;
    if (user) {
      this.state.user = user;
      await this.refresh();
    }
    return !!user;
  }

  async signOut() {
    await this.store.signOut?.();
    this.state.user = null;
    await this.refresh();
    this.toast('Signed out');
  }

  async askName(): Promise<boolean> {
    if (this.state.modalOpen || !this.store.setUserName) return false;
    this.state.modalOpen = true;
    const saved = await promptForName({
      container: this.root,
      currentName: this.state.user?.name,
      onSave: async (name) => {
        this.state.user = await this.store.setUserName!(name);
      },
    });
    this.state.modalOpen = false;
    if (saved) await this.refresh();
    return saved;
  }

  async setPlacing(on: boolean) {
    if (on && !(await this.ensureUser())) return;
    this.state.placing = on;
    if (!on) this.state.hoverEl = null;
    document.documentElement.classList.toggle('pc-placing', on);
    this.hint.classList.toggle('show', on);
    this.renderToolbar();
  }

  setPinsVisible(on: boolean) {
    this.state.pinsVisible = on;
    this.renderToolbar();
    this.renderPins();
  }

  setSidebar(open: boolean) {
    this.state.sidebarOpen = open;
    this.renderToolbar();
    this.sidebar.render();
  }

  setScope(scope: Scope) {
    this.state.scope = scope;
    this.sidebar.render();
  }

  setFilter(filter: Filter) {
    this.state.filter = filter;
    this.renderPins();
    this.renderToolbar();
    this.sidebar.render();
  }

  openThread(id: string) {
    this.state.draft = null;
    this.state.activeId = id;
    this.renderPins();
    this.renderPopover();
    this.sidebar.render();
    void this.store.loadComments?.(id);
  }

  closeThread() {
    if (!this.state.activeId) return;
    this.state.activeId = null;
    this.renderPins();
    this.renderPopover();
    this.sidebar.render();
  }

  cancelDraft() {
    if (!this.state.draft) return;
    this.state.draft = null;
    this.drafts.delete(NEW_DRAFT_KEY);
    this.resolved.delete(DRAFT_ID);
    this.renderPins();
    this.renderPopover();
  }

  /** Opens a thread from the sidebar, navigating to its page if needed. */
  goToThread(t: Thread) {
    if (t.page !== this.state.page) {
      location.href = withThreadParam(t.url || t.page, t.id);
      return;
    }
    if (window.innerWidth < 720) this.setSidebar(false);
    this.openThread(t.id);
    const el = resolveElement(t.pin);
    if (el && el !== document.body && el !== document.documentElement) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    } else {
      window.scrollTo({ top: t.pin.page.y - window.innerHeight / 2, left: 0, behavior: 'smooth' });
    }
  }

  async toggleResolved(t: Thread) {
    if (!(await this.ensureUser())) return;
    try {
      await this.store.setStatus(t.id, t.status === 'resolved' ? 'open' : 'resolved', this.state.user!);
      await this.refresh();
    } catch (err) {
      console.error(LOG, err);
      this.toast('Couldn’t update the thread');
    }
  }

  async exportJson() {
    if (!this.store.exportData) return;
    const data = await this.store.exportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const link = h('a', {
      href: URL.createObjectURL(blob),
      download: `comments-${this.config.project}-${new Date().toISOString().slice(0, 10)}.json`,
    });
    this.root.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  async importJson(file: File) {
    if (!this.store.importData) return;
    try {
      const { added, updated } = await this.store.importData(JSON.parse(await file.text()));
      await this.refresh();
      this.toast(`Imported ${added} new and ${updated} updated threads`);
    } catch (err) {
      console.error(LOG, err);
      this.toast(err instanceof Error ? err.message : 'Couldn’t import that file');
    }
  }

  toast(message: string) {
    this.toastEl.textContent = message;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 2600);
  }

  // ---------- Page integration ----------

  private injectPageStyles() {
    const style = document.createElement('style');
    style.setAttribute('data-prototype-comments', '');
    style.textContent = `html.pc-placing, html.pc-placing * { cursor: ${COMMENT_CURSOR} !important; }`;
    document.head.append(style);
  }

  private isOurs(e: Event): boolean {
    return e.composedPath().includes(this.host);
  }

  private bindPageEvents() {
    const blocker = (e: Event) => {
      if (!this.state.placing || this.state.modalOpen || this.isOurs(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === 'click') this.placeAt(e as MouseEvent);
    };
    for (const type of BLOCKED_EVENTS) window.addEventListener(type, blocker, true);

    window.addEventListener(
      'mousemove',
      (e) => {
        if (!this.state.placing) return;
        this.state.hoverEl = this.isOurs(e) ? null : (e.target as Element);
      },
      true,
    );

    // Clicking the page closes an open thread, like clicking the canvas in Figma.
    window.addEventListener(
      'pointerdown',
      (e) => {
        if (this.state.placing || this.isOurs(e)) return;
        if (this.state.activeId) this.closeThread();
        if (this.state.draft && !this.drafts.get(NEW_DRAFT_KEY)?.trim()) this.cancelDraft();
      },
      true,
    );

    window.addEventListener('keydown', (e) => this.onKeyDown(e), true);
  }

  private onKeyDown(e: KeyboardEvent) {
    if (this.state.modalOpen) return;
    if (e.key === 'Escape') {
      if (this.state.draft) this.cancelDraft();
      else if (this.state.activeId) this.closeThread();
      else if (this.state.placing) void this.setPlacing(false);
      else if (this.state.sidebarOpen) this.setSidebar(false);
      return;
    }
    if (!this.config.shortcuts || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    const target = e.composedPath()[0] as HTMLElement | undefined;
    const typing = !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    if (typing || e.code !== 'KeyC') return;
    e.preventDefault();
    if (e.shiftKey) this.setPinsVisible(!this.state.pinsVisible);
    else void this.setPlacing(!this.state.placing);
  }

  private placeAt(e: MouseEvent) {
    // Don't throw away a comment that's being written.
    if (this.state.draft && this.drafts.get(NEW_DRAFT_KEY)?.trim()) {
      this.popover.classList.remove('nudge');
      void this.popover.offsetWidth;
      this.popover.classList.add('nudge');
      return;
    }
    const target = e.target instanceof Element ? e.target : document.body;
    this.state.activeId = null;
    this.state.draft = { pin: makePin(target, e.clientX, e.clientY) };
    this.resolved.delete(DRAFT_ID);
    this.renderPins();
    this.renderPopover();
    // Focus synchronously: deferring it lets the first keystrokes fall through to the page.
    this.popover.querySelector('textarea')?.focus();
  }

  /** Handles single-page-app navigation as well as normal page loads. */
  private watchNavigation() {
    const onChange = () => {
      const page = pageKeyFor(this.config.pageKey);
      if (page === this.state.page) return;
      this.state.page = page;
      this.state.draft = null;
      this.state.activeId = null;
      this.resolved.clear();
      this.render();
    };
    for (const method of ['pushState', 'replaceState'] as const) {
      const original = history[method];
      history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
        const result = original.apply(this, args);
        queueMicrotask(onChange);
        return result;
      };
    }
    window.addEventListener('popstate', onChange);
    window.addEventListener('hashchange', onChange);
  }

  private openFromUrl() {
    const params = new URLSearchParams(location.search);
    const id = params.get(THREAD_PARAM);
    if (!id) return;
    history.replaceState(history.state, '', cleanUrl());
    const t = this.thread(id);
    if (!t) {
      this.toast('That comment no longer exists');
      return;
    }
    // Give the prototype a moment to finish laying out.
    setTimeout(() => this.goToThread(t), 250);
  }

  // ---------- Rendering ----------

  render() {
    this.renderToolbar();
    this.renderPins();
    this.renderPopover();
    this.sidebar.render();
  }

  private buildToolbar() {
    const comment = h(
      'button',
      { class: 'tb-btn', type: 'button', title: 'Add a comment (C)', 'aria-label': 'Add a comment', onClick: () => void this.setPlacing(!this.state.placing) },
      icon('comment', 18),
    );
    const eye = h('button', {
      class: 'tb-btn',
      type: 'button',
      title: 'Show or hide comments (Shift+C)',
      'aria-label': 'Show or hide comments',
      onClick: () => this.setPinsVisible(!this.state.pinsVisible),
    });
    const badge = h('span', { class: 'badge' }, '0');
    const list = h(
      'button',
      { class: 'tb-btn', type: 'button', title: 'All comments', 'aria-label': 'All comments', onClick: () => this.setSidebar(!this.state.sidebarOpen) },
      icon('list', 18),
      badge,
    );
    const me = h('button', { class: 'tb-btn me', type: 'button', title: 'Your name', 'aria-label': 'Your name', onClick: () => void this.ensureUserOrRename() });
    const grip = h(
      'button',
      { class: 'tb-grip', type: 'button', title: 'Drag to move (or use arrow keys)', 'aria-label': 'Move toolbar' },
      icon('grip', 16),
    );
    grip.addEventListener('keydown', (e) => {
      const next = stepPosition(this.state.toolbarPosition, e.key);
      if (next === this.state.toolbarPosition) return;
      e.preventDefault();
      e.stopPropagation();
      this.setToolbarPosition(next);
    });
    const el = h('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Comments' }, grip, comment, eye, list, h('span', { class: 'tb-sep' }), me);
    makeDraggable(el, grip, (position) => this.setToolbarPosition(position));
    return { el, comment, eye, list, badge, me };
  }

  setToolbarPosition(position: ToolbarPosition) {
    this.state.toolbarPosition = position;
    saveToolbarPosition(position);
    this.renderToolbar();
  }

  private async ensureUserOrRename() {
    if (this.store.auth === 'name') await this.askName();
    else if (this.state.user) this.setSidebar(true); // sign out lives in the sidebar footer
    else await this.ensureUser();
  }

  private renderToolbar() {
    const { el, comment, eye, list, badge, me } = this.toolbar;
    comment.classList.toggle('active', this.state.placing);
    eye.replaceChildren(icon(this.state.pinsVisible ? 'eye' : 'eyeOff', 18));
    list.classList.toggle('active', this.state.sidebarOpen);
    badge.textContent = String(this.pageThreads().filter((t) => t.status === 'open').length);
    me.replaceChildren(this.state.user ? avatar(this.state.user, 22) : icon('user', 18));
    me.title = this.state.user ? `Commenting as ${this.state.user.name}` : this.store.auth === 'signin' ? 'Sign in to comment' : 'Set your name';
    el.classList.toggle('shifted', this.state.sidebarOpen && window.innerWidth >= 720);
    el.dataset.pos = this.state.toolbarPosition;
    // The hint and toasts go on the opposite edge from the toolbar, so they never overlap it.
    this.root.classList.toggle('toolbar-top', this.state.toolbarPosition.startsWith('top'));
  }

  private renderPins() {
    const visible = new Set<string>();
    for (const t of this.pageThreads()) {
      if ((this.state.pinsVisible && this.matchesFilter(t)) || t.id === this.state.activeId) visible.add(t.id);
    }

    for (const [id, el] of this.pinEls) {
      if (!visible.has(id)) {
        el.remove();
        this.pinEls.delete(id);
      }
    }
    for (const id of visible) {
      const t = this.thread(id)!;
      let el = this.pinEls.get(id);
      if (!el) {
        el = h('button', {
          class: 'pin',
          type: 'button',
          onClick: (e: MouseEvent) => {
            e.stopPropagation();
            if (this.state.activeId === id) this.closeThread();
            else this.openThread(id);
          },
        });
        el.style.display = 'none'; // positioned on the next frame
        this.pinEls.set(id, el);
        this.layer.append(el);
      }
      const count = this.commentCount(t);
      el.replaceChildren(avatar(t.createdBy, 26), ...(count > 1 ? [h('span', { class: 'count' }, String(count))] : []));
      el.classList.toggle('active', id === this.state.activeId);
      el.classList.toggle('resolved', t.status === 'resolved');
      el.setAttribute('aria-label', `Comment by ${t.createdBy.name}: ${t.comments[0]?.body ?? ''}`);
    }

    if (this.state.draft) {
      if (!this.draftPin) {
        this.draftPin = h('button', { class: 'pin active', type: 'button', tabindex: -1, 'aria-hidden': 'true' });
        this.draftPin.style.display = 'none';
        this.layer.append(this.draftPin);
      }
      this.draftPin.replaceChildren(avatar(this.state.user, 26));
    } else if (this.draftPin) {
      this.draftPin.remove();
      this.draftPin = null;
    }
  }

  private renderPopover() {
    const { draft, activeId } = this.state;
    const t = activeId ? this.thread(activeId) : undefined;
    if (!draft && !t) {
      this.popover.hidden = true;
      this.popover.replaceChildren();
      return;
    }

    // Keep focus and caret if we're re-rendering under someone who is typing.
    const focused = this.shadow.activeElement;
    const caret = focused instanceof HTMLTextAreaElement && this.popover.contains(focused) ? [focused.selectionStart, focused.selectionEnd] : null;

    this.popover.hidden = false;
    this.popover.classList.toggle('is-draft', !!draft);
    if (draft) this.popover.replaceChildren(this.buildDraft());
    else this.popover.replaceChildren(...this.buildThread(t!));

    if (caret) {
      const textarea = this.popover.querySelector('textarea');
      textarea?.focus();
      textarea?.setSelectionRange(caret[0], caret[1]);
    }
  }

  private composer(key: string, placeholder: string, onSubmit: (body: string, mentions: User[]) => Promise<void>, onCancel: () => void) {
    return createComposer({
      placeholder,
      initialValue: this.drafts.get(key) ?? '',
      getUsers: () => this.state.users,
      onChange: (value) => this.drafts.set(key, value),
      onSubmit,
      onCancel,
      onError: (message) => this.toast(message),
    });
  }

  private buildDraft(): HTMLElement {
    const composer = this.composer(
      NEW_DRAFT_KEY,
      'Add a comment… (@ to mention)',
      async (body, mentions) => {
        const draft = this.state.draft;
        if (!draft || !this.state.user) return;
        const thread = await this.store.createThread({
          page: this.state.page,
          url: cleanUrl(),
          pin: draft.pin,
          body,
          mentions,
          author: this.state.user,
        });
        this.drafts.delete(NEW_DRAFT_KEY);
        this.resolved.delete(DRAFT_ID);
        this.state.draft = null;
        this.state.activeId = thread.id;
        await this.setPlacing(false);
        await this.refresh();
      },
      () => this.cancelDraft(),
    );
    return composer.el;
  }

  private buildThread(t: Thread): HTMLElement[] {
    const resolved = t.status === 'resolved';
    const head = h(
      'div',
      { class: 'pop-head' },
      h('div', { class: 'pop-title' }, 'Comment', resolved && t.resolvedBy ? h('span', { class: 'sub' }, `Resolved by ${t.resolvedBy.name}`) : null),
      h(
        'button',
        {
          class: `icon-btn${resolved ? ' on' : ''}`,
          type: 'button',
          title: resolved ? 'Reopen' : 'Resolve',
          'aria-label': resolved ? 'Reopen thread' : 'Resolve thread',
          onClick: () => void this.toggleResolved(t),
        },
        icon(resolved ? 'reopen' : 'check'),
      ),
      this.isMine(t.createdBy)
        ? this.confirmButton('Delete thread', async () => {
            await this.store.deleteThread(t.id);
            this.state.activeId = null;
            await this.refresh();
          })
        : null,
      h('button', { class: 'icon-btn', type: 'button', title: 'Close (Esc)', 'aria-label': 'Close', onClick: () => this.closeThread() }, icon('close')),
    );

    const note = h('div', { class: 'orphan-note' }, 'The element this comment was pinned to isn’t visible right now.');

    const notLoaded = this.commentCount(t) - t.comments.length;
    const list = h(
      'div',
      { class: 'comments' },
      t.comments.map((c, i) => {
        const canDelete = this.isMine(c.author) && (this.store.canDeleteComment?.(c) ?? true);
        return h(
          'div',
          { class: `comment${c.delivery ? ` ${c.delivery}` : ''}` },
          avatar(c.author, 28),
          h(
            'div',
            { class: 'c-main' },
            h(
              'div',
              { class: 'meta' },
              h('span', { class: 'name' }, c.author?.name ?? 'Unknown'),
              h('span', { class: 'time', title: new Date(c.createdAt).toLocaleString() }, c.delivery === 'pending' ? 'Sending…' : timeAgo(c.createdAt)),
            ),
            h('div', { class: 'body' }, renderBody(c.body, c.mentions)),
            c.delivery === 'failed'
              ? h(
                  'div',
                  { class: 'delivery-error' },
                  `Not sent${c.error ? `: ${c.error}` : ''} · `,
                  h('button', { class: 'link', type: 'button', onClick: () => void this.store.retryFailed?.() }, 'Retry'),
                )
              : null,
          ),
          canDelete
            ? this.confirmButton(
                c.delivery && i === 0 && !t.remoteId ? 'Discard comment' : 'Delete comment',
                async () => {
                  await this.store.deleteComment(t.id, c.id);
                  await this.refresh();
                },
                'del',
              )
            : null,
        );
      }),
      notLoaded > 0 ? h('div', { class: 'loading-more' }, `Loading ${notLoaded} more…`) : null,
    );
    requestAnimationFrame(() => (list.scrollTop = list.scrollHeight));

    const composer = this.composer(
      t.id,
      'Reply… (@ to mention)',
      async (body, mentions) => {
        if (!(await this.ensureUser())) return;
        await this.store.addComment(t.id, { body, mentions, author: this.state.user! });
        this.drafts.delete(t.id);
        await this.refresh();
      },
      () => this.closeThread(),
    );

    return [head, note, list, composer.el];
  }

  /** Trash button that needs a second click to confirm. */
  private confirmButton(label: string, onConfirm: () => Promise<void>, extraClass = ''): HTMLButtonElement {
    let armed = false;
    let timer = 0;
    const btn = h('button', { class: `icon-btn ${extraClass}`.trim(), type: 'button', title: label, 'aria-label': label }, icon('trash'));
    const disarm = () => {
      armed = false;
      btn.classList.remove('armed');
      btn.replaceChildren(icon('trash'));
    };
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!armed) {
        armed = true;
        btn.classList.add('armed');
        btn.replaceChildren('Delete?');
        timer = window.setTimeout(disarm, 3000);
        return;
      }
      clearTimeout(timer);
      try {
        await onConfirm();
      } catch (err) {
        console.error(LOG, err);
        this.toast('Couldn’t delete that');
        disarm();
      }
    });
    return btn;
  }

  // ---------- Positioning (every frame) ----------

  private tick = () => {
    this.frame++;
    try {
      this.positionAll();
    } catch (err) {
      console.error(LOG, err);
    }
    requestAnimationFrame(this.tick);
  };

  locate(id: string, pin: Pin): Point | null {
    let entry = this.resolved.get(id);
    if (!entry || (entry.el && !entry.el.isConnected) || this.frame - entry.frame > RESOLVE_EVERY) {
      entry = { el: resolveElement(pin), frame: this.frame };
      this.resolved.set(id, entry);
    }
    return pointFor(pin, entry.el);
  }

  private positionAll() {
    for (const [id, el] of this.pinEls) {
      const t = this.thread(id);
      this.placePin(el, t ? this.locate(id, t.pin) : null);
    }
    if (this.draftPin && this.state.draft) this.placePin(this.draftPin, this.locate(DRAFT_ID, this.state.draft.pin));
    this.positionPopover();
    this.positionHighlight();
  }

  private placePin(el: HTMLElement, p: Point | null) {
    if (!p) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    const transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y - PIN_SIZE)}px)`;
    if (el.style.transform !== transform) el.style.transform = transform;
    if (el.classList.contains('detached') === p.anchored) el.classList.toggle('detached', !p.anchored);
  }

  private positionPopover() {
    if (this.popover.hidden) return;
    const { draft, activeId } = this.state;
    const pin = draft ? draft.pin : activeId ? this.thread(activeId)?.pin : undefined;
    if (!pin) return;
    const p = this.locate(draft ? DRAFT_ID : activeId!, pin);
    if (!draft) this.popover.classList.toggle('orphan', !p);

    const w = this.popover.offsetWidth;
    const ht = this.popover.offsetHeight;
    const right = window.innerWidth - (this.state.sidebarOpen && window.innerWidth >= 720 ? SIDEBAR_WIDTH : 0);
    let x: number;
    let y: number;
    if (p) {
      x = p.x + PIN_SIZE + 8;
      y = p.y - PIN_SIZE;
      if (x + w > right - GAP) x = p.x - w - 8;
    } else {
      x = (right - w) / 2;
      y = 80;
    }
    x = clamp(x, GAP, Math.max(GAP, right - w - GAP));
    y = clamp(y, GAP, Math.max(GAP, window.innerHeight - ht - GAP));
    const transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    if (this.popover.style.transform !== transform) this.popover.style.transform = transform;
  }

  private positionHighlight() {
    const el = this.state.placing && !this.state.modalOpen ? this.state.hoverEl : null;
    if (!el || !el.isConnected || el === document.body || el === document.documentElement) {
      this.highlight.hidden = true;
      return;
    }
    const r = el.getBoundingClientRect();
    this.highlight.hidden = false;
    Object.assign(this.highlight.style, {
      transform: `translate(${Math.round(r.left)}px, ${Math.round(r.top)}px)`,
      width: `${Math.round(r.width)}px`,
      height: `${Math.round(r.height)}px`,
    });
  }
}
