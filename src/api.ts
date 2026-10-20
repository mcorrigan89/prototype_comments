/**
 * The HTTP contract between comments.js and the backend (server/).
 * Imported by both sides so they can't drift apart.
 */
import type { Comment, Pin, Thread, ThreadStatus, User } from './types';

/**
 * Every thread route takes `?db=…`: the prototype's feedback database, as given
 * in the script tag's data-notion (a Notion link or id).
 */

/** GET /threads?db=…[&since=ISO] */
export interface SyncResponse {
  threads: Thread[];
  /** true when this is every thread in the database (no `since`), so missing ones were deleted. */
  full: boolean;
  /** Pass back as `since` next time. */
  serverTime: string;
}

/** POST /threads?db=… */
export interface CreateThreadBody {
  /** Client-generated id, used as the thread id and to make retries idempotent. */
  clientId: string;
  page: string;
  url: string;
  pin: Pin;
  body: string;
  mentions: User[];
}

/** PATCH /threads/:remoteId?db=… */
export interface UpdateThreadBody {
  status: ThreadStatus;
}

/** POST /threads/:remoteId/comments?db=… */
export interface AddCommentBody {
  body: string;
  mentions: User[];
  /** Set when re-sending, so the server can skip a duplicate. */
  retry?: boolean;
}

/** GET|POST /threads/:remoteId/comments?db=… */
export interface CommentsResponse {
  comments: Comment[];
}

/** GET /users */
export interface UsersResponse {
  users: User[];
}

export interface ErrorResponse {
  error: string;
  code?: 'unauthorized' | 'forbidden' | 'not_found' | 'bad_request' | 'busy' | 'upstream' | 'config';
}

/** Payload of the signed session token. Readable (not secret), but only the server can mint it. */
export interface SessionClaims {
  sub: string;
  name: string;
  email?: string;
  avatarUrl?: string;
  /** Expiry, seconds since epoch. */
  exp: number;
}

/**
 * After sign-in the backend redirects back to the prototype with these in the
 * URL hash (never the query, so tokens don't end up in S3 access logs).
 */
export const AUTH_HASH = {
  token: 'pc-auth',
  error: 'pc-auth-error',
  /** The prototype's own hash, restored after we strip ours. */
  returnHash: 'pc-return-hash',
  /** Present when sign-in happened in a popup that should close itself. */
  popup: 'pc-popup',
} as const;

export function userFromClaims(claims: SessionClaims): User {
  return {
    id: claims.sub,
    name: claims.name,
    ...(claims.email ? { email: claims.email } : {}),
    ...(claims.avatarUrl ? { avatarUrl: claims.avatarUrl } : {}),
  };
}
