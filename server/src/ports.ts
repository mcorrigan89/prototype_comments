import type { CreateThreadBody } from '../../src/api';
import type { Comment, Thread, ThreadStatus, User } from '../../src/types';

export { notionIdFrom } from '../../src/util';

/**
 * Where everything lives. Each prototype's comments live under the Notion page
 * named by its script tag's data-notion; open() finds them. NotionWorkspace is
 * the real one; MemoryWorkspace stands in for Notion during local development
 * and tests.
 */
export interface Workspace {
  /**
   * Resolves a script tag's data-notion (a Notion link or id) to its comments.
   * With `create`, sets up storage if there isn't any yet; without it, a page
   * with no comments yet reads as empty. Throws an HttpError if the link can't be used.
   */
  open(db: string, options?: { create?: boolean }): Promise<Store>;
  /** Workspace members: who can sign in and be @mentioned. */
  listUsers(): Promise<User[]>;
}

/**
 * One prototype's feedback database.
 *
 * List methods return thread *summaries*: `comments` holds only the first
 * comment and `commentCount` the total. Full comments come from listComments().
 */
export interface Store {
  /** Normalised id from the data-notion link, used as Thread.project. */
  readonly id: string;
  listThreads(since?: string): Promise<Thread[]>;
  /** null if it doesn't exist, was deleted, or isn't in this database. */
  getThread(remoteId: string): Promise<Thread | null>;
  findByClientId(clientId: string): Promise<Thread | null>;
  createThread(input: NewThreadInput): Promise<Thread>;
  setStatus(remoteId: string, status: ThreadStatus, by: User): Promise<Thread>;
  trashThread(remoteId: string): Promise<void>;
  listComments(remoteId: string): Promise<Comment[]>;
  /** Adds a comment and returns the thread's full comment list. */
  addComment(remoteId: string, input: { body: string; mentions: User[]; author: User }): Promise<Comment[]>;
}

export type NewThreadInput = Omit<CreateThreadBody, 'db'> & { author: User };

/** Who someone is. NotionIdentity uses Notion OAuth; FakeIdentity shows a "pick a user" page. */
export interface Identity {
  readonly kind: 'notion' | 'fake';
  /** Where to send the browser to start sign-in. */
  authorizeUrl(state: string, redirectUri: string): string;
  /** Turns the callback's `code` into a verified user. */
  exchange(code: string, redirectUri: string): Promise<User>;
}
