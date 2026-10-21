import type { ForumContext } from "./context.js";
import type { Viewer } from "./types.js";

/**
 * "New since last visit." A thread is unread for a member when its last post
 * is newer than both their read marker for that thread and their
 * marked_read_at (join date, or the last "Mark all read").
 *
 * `userParam` is the SQL placeholder holding the member's id, or NULL for
 * anonymous visitors, for whom nothing is ever unread.
 */
export function unreadSql(t: string, userParam: string): string {
  return `(${userParam}::bigint IS NOT NULL
    AND ${t}.last_post_at > (SELECT marked_read_at FROM users WHERE id = ${userParam}::bigint)
    AND ${t}.last_post_id > COALESCE(
      (SELECT rm.last_read_post_id FROM read_markers rm
        WHERE rm.user_id = ${userParam}::bigint AND rm.thread_id = ${t}.id), 0))`;
}

/** Records that the member has read a thread up to a post. Never moves backwards. */
export async function markThreadRead(
  ctx: ForumContext,
  viewer: Viewer,
  threadId: number,
  postId: number
): Promise<void> {
  await ctx.pool.query(
    `INSERT INTO read_markers (user_id, thread_id, last_read_post_id) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, thread_id) DO UPDATE
       SET last_read_post_id = GREATEST(read_markers.last_read_post_id, EXCLUDED.last_read_post_id),
           updated_at = NOW()`,
    [viewer.id, threadId, postId]
  );
}

export async function markAllRead(ctx: ForumContext, viewer: Viewer): Promise<void> {
  await ctx.pool.query("UPDATE users SET marked_read_at = NOW() WHERE id = $1", [viewer.id]);
  // Markers older than that are now meaningless.
  await ctx.pool.query("DELETE FROM read_markers WHERE user_id = $1", [viewer.id]);
}

/** The first post the member hasn't read in a thread, or null if they're caught up. */
export async function firstUnreadPostId(
  ctx: ForumContext,
  viewer: Viewer,
  threadId: number
): Promise<number | null> {
  const { rows } = await ctx.pool.query<{ id: number }>(
    `SELECT p.id FROM posts p
      WHERE p.thread_id = $2
        AND p.id > COALESCE((SELECT last_read_post_id FROM read_markers WHERE user_id = $1 AND thread_id = $2), 0)
        AND p.created_at > (SELECT marked_read_at FROM users WHERE id = $1)
      ORDER BY p.id LIMIT 1`,
    [viewer.id, threadId]
  );
  return rows[0]?.id ?? null;
}

/**
 * Posts the member had already read in a thread that were edited since they
 * last read it, by position in the thread, oldest first. Their own edits
 * don't count, nor do removed posts. Read before markThreadRead moves the
 * marker on.
 */
export async function editedSinceRead(
  ctx: ForumContext,
  viewer: Viewer,
  threadId: number
): Promise<{ postId: number; position: number; editedAt: Date }[]> {
  const { rows } = await ctx.pool.query<{ id: number; position: string; edited_at: Date }>(
    `SELECT x.id, x.position, x.edited_at
       FROM (SELECT p.id, p.edited_at, p.edited_by, p.deleted_at, ROW_NUMBER() OVER (ORDER BY p.id) AS position
               FROM posts p WHERE p.thread_id = $2) x
       JOIN read_markers rm ON rm.user_id = $1 AND rm.thread_id = $2
      WHERE x.id <= rm.last_read_post_id
        AND x.edited_at > rm.updated_at
        AND x.edited_by IS DISTINCT FROM $1
        AND x.deleted_at IS NULL
      ORDER BY x.id`,
    [viewer.id, threadId]
  );
  return rows.map((r) => ({ postId: r.id, position: Number(r.position), editedAt: r.edited_at }));
}
