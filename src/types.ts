export interface User {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string;
}

/** Everything needed to put a pin back where it was dropped. */
export interface Pin {
  /** CSS selector for the element that was clicked. */
  selector: string;
  /** Lowercased tag name, used to re-find the element by text if the selector breaks. */
  tag: string;
  /** First 80 chars of the element's text, used as a sanity check. */
  text: string;
  /** Position inside the element, as a fraction of its width/height (0–1). */
  offset: { x: number; y: number };
  /** Document coordinates at the time of the click — fallback if the element is gone. */
  page: { x: number; y: number };
  /** Viewport size at the time of the click. */
  viewport: { w: number; h: number };
}

export interface Comment {
  id: string;
  author: User;
  body: string;
  mentions: User[];
  createdAt: string;
  /** Set while a comment only exists locally: queued for sending, or rejected by the server. */
  delivery?: 'pending' | 'failed';
  /** Why delivery failed, shown next to the retry button. */
  error?: string;
}

export type ThreadStatus = 'open' | 'resolved';

export interface Thread {
  id: string;
  project: string;
  /** Normalised page path, e.g. "/cart.html". */
  page: string;
  /** Full URL of the page, used for links from the sidebar and from the backend. */
  url: string;
  pin: Pin;
  status: ThreadStatus;
  createdBy: User;
  createdAt: string;
  updatedAt: string;
  resolvedBy?: User;
  resolvedAt?: string;
  /**
   * The comments loaded so far. Remote storage only sends the first comment
   * in list syncs; the rest are fetched when the thread is opened.
   */
  comments: Comment[];
  /** Total number of comments, when it can exceed comments.length. */
  commentCount?: number;
  /** Backend id (e.g. the Notion page id) when it differs from id. */
  remoteId?: string;
}

export interface NewThread {
  page: string;
  url: string;
  pin: Pin;
  body: string;
  mentions: User[];
  author: User;
}

export interface NewComment {
  body: string;
  mentions: User[];
  author: User;
}

export interface ExportFile {
  format: 'prototype-comments';
  version: 1;
  project: string;
  exportedAt: string;
  threads: Thread[];
}

/**
 * The UI only talks to storage through this interface, so the local
 * adapter can be swapped for a remote one (e.g. Notion) without UI changes.
 */
export interface StorageAdapter {
  readonly name: string;
  /** Short human description shown in the sidebar footer, e.g. sync status. */
  readonly label: string;
  /**
   * How the current user is identified:
   * - "name": the overlay asks for a display name and calls setUserName()
   * - "signin": the adapter handles sign-in itself via signIn()
   */
  readonly auth: 'name' | 'signin';

  listThreads(): Promise<Thread[]>;
  createThread(input: NewThread): Promise<Thread>;
  addComment(threadId: string, input: NewComment): Promise<Comment>;
  setStatus(threadId: string, status: ThreadStatus, by: User): Promise<Thread>;
  deleteComment(threadId: string, commentId: string): Promise<void>;
  /** Whether the current user may delete this comment. Defaults to "it's theirs". */
  canDeleteComment?(comment: Comment): boolean;
  deleteThread(threadId: string): Promise<void>;
  /** Fetch every comment of a thread (remote storage loads them on demand). */
  loadComments?(threadId: string): Promise<void>;
  /** Re-send changes that the server rejected. */
  retryFailed?(): Promise<void>;

  getCurrentUser(): Promise<User | null>;
  setUserName?(name: string): Promise<User>;
  /** Starts sign-in. Must be called from a click handler so the popup isn't blocked. */
  signIn?(): Promise<User | null>;
  /** Gives up waiting for a sign-in started with signIn(). */
  cancelSignIn?(): void;
  signOut?(): Promise<void>;
  /** A one-off message for the user (e.g. "Signed in"), consumed when read. */
  takeNotice?(): string | null;
  listUsers(): Promise<User[]>;

  exportData?(): Promise<ExportFile>;
  importData?(data: unknown): Promise<{ added: number; updated: number }>;

  /** Called whenever data may have changed outside this page (other tabs, other people). */
  subscribe(listener: () => void): () => void;
}

export interface AdapterOptions {
  project: string;
  users: User[];
  endpoint?: string;
  /** The prototype's Notion feedback database (link or id), for remote storage. */
  notion?: string;
}

export type AdapterFactory = (options: AdapterOptions) => StorageAdapter;

export interface Config {
  project: string;
  storage: string;
  /** "path" ignores the hash; "path+hash" treats hash routes as separate pages. */
  pageKey: 'path' | 'path+hash';
  users: User[];
  shortcuts: boolean;
  endpoint?: string;
  notion?: string;
}
