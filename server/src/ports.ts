import type { CreateThreadBody } from '../../src/api';
import type { Comment, Thread, ThreadStatus, User } from '../../src/types';

export { notionIdFrom } from '../../src/util';

/**
 * Where everything lives. Each prototype has its own feedback database, named
 * by the script tag's data-notion; open() checks it's one of ours and returns
 * its store. NotionWorkspace is the real one; MemoryWorkspace stands in for
 * Notion during local development and tests.
 */
export interface Workspace {
  /**
   * Resolves a database reference from a script tag (a Notion link or id).
   * Throws an HttpError if it isn't a usable feedback database.
   */
  open(db: string): Promise<Store>;
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
  /** Normalised id of the database, used as Thread.project. */
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
