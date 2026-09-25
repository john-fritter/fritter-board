import type { Viewer } from "./types.js";

/**
 * The access model, in one place. Bots and humans are both members and get
 * identical answers; nothing here looks at isBot.
 */

export function isMember(v: Viewer | null): v is Viewer {
  return v !== null && v.status === "active";
}

export function isModerator(v: Viewer | null): boolean {
  return isMember(v) && (v.role === "moderator" || v.role === "admin");
}

export function isAdmin(v: Viewer | null): boolean {
  return isMember(v) && v.role === "admin";
}

/**
 * Narrowing versions for guard clauses: `if (!asModerator(v)) throw …` leaves
 * v typed as a Viewer. (isModerator itself stays boolean, because "not a
 * moderator" must not narrow v to null.)
 */
export function asModerator(v: Viewer | null): v is Viewer {
  return isModerator(v);
}

export function asAdmin(v: Viewer | null): v is Viewer {
  return isAdmin(v);
}

/** Members-only boards don't exist as far as anyone else can tell. */
export function canSeeBoard(v: Viewer | null, board: { membersOnly: boolean }): boolean {
  return !board.membersOnly || isMember(v);
}

export function canPost(v: Viewer | null): v is Viewer {
  return isMember(v);
}

/** Locked threads still take replies from moderators. */
export function canReply(v: Viewer | null, thread: { locked: boolean }): v is Viewer {
  return isMember(v) && (!thread.locked || isModerator(v));
}

/** SQL predicate for boards visible to the viewer, for list and search queries. */
export function visibleBoardsSql(v: Viewer | null, alias = "b"): string {
  return isMember(v)
    ? `${alias}.deleted_at IS NULL`
    : `${alias}.deleted_at IS NULL AND NOT ${alias}.members_only`;
}

/** Authors edit their own posts; in a locked thread only moderators edit. */
export function canEditPost(
  v: Viewer | null,
  post: { authorId: number; deleted: boolean },
  thread: { locked: boolean }
): v is Viewer {
  return isMember(v) && v.id === post.authorId && !post.deleted && (!thread.locked || isModerator(v));
}

/** Edit history is for the author and the moderators. */
export function canSeeEditHistory(v: Viewer | null, post: { authorId: number }): boolean {
  return isModerator(v) || (isMember(v) && v.id === post.authorId);
}

/** Removing a post is a moderator call; reversing one is the admin's. */
export function canRemovePost(v: Viewer | null): v is Viewer {
  return asModerator(v);
}

export function canRestorePost(v: Viewer | null): v is Viewer {
  return asAdmin(v);
}

/** Suspending or banning a member affects their membership, so it needs the admin. */
export function canChangeMemberStatus(v: Viewer | null): v is Viewer {
  return asAdmin(v);
}

/** PMs are private to their participants, except that the admin can read all of them. */
export function canReadConversation(v: Viewer | null, participantIds: readonly number[]): v is Viewer {
  return v !== null && (participantIds.includes(v.id) || isAdmin(v));
}
