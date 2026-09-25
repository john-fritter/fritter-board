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
