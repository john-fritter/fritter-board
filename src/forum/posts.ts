import { withTransaction } from "../db/index.js";
import { MARKUP_VERSION } from "../markup/bbcode.js";
import type { ForumContext } from "./context.js";
import { forbidden, notFound } from "./errors.js";
import { canEditPost, canSeeBoard, canSeeEditHistory } from "./permissions.js";
import { getPost } from "./threads.js";
import type { Viewer } from "./types.js";
import { validatePostBody, validateThreadTitle } from "./validate.js";

/**
 * Edits a post. The previous body goes to post_edits first, so every version
 * survives. Editing a thread's first post may also retitle the thread.
 */
export async function editPost(
  ctx: ForumContext,
  viewer: Viewer | null,
  postId: number,
  rawBody: string,
  rawTitle?: string
): Promise<void> {
  const body = validatePostBody(rawBody);

  await withTransaction(ctx.pool, async (client) => {
    const { rows } = await client.query<{
      author_id: number;
      body: string;
      deleted_at: Date | null;
      thread_id: number;
      locked: boolean;
      first_post_id: number;
      members_only: boolean;
    }>(
      `SELECT p.author_id, p.body, p.deleted_at, p.thread_id, t.locked, t.first_post_id, b.members_only
         FROM posts p
         JOIN threads t ON t.id = p.thread_id
         JOIN boards b ON b.id = t.board_id
        WHERE p.id = $1 AND t.deleted_at IS NULL AND b.deleted_at IS NULL
        FOR UPDATE OF p`,
      [postId]
    );
    const r = rows[0];
    if (!r || !canSeeBoard(viewer, { membersOnly: r.members_only })) throw notFound("That post");
    const post = { authorId: r.author_id, deleted: r.deleted_at !== null };
    if (!canEditPost(viewer, post, { locked: r.locked })) throw forbidden("You can't edit that post.");

    const retitle = rawTitle !== undefined && r.first_post_id === postId;
    const title = retitle ? validateThreadTitle(rawTitle) : null;
    if (body === r.body && title === null) return;

    if (body !== r.body) {
      await client.query("INSERT INTO post_edits (post_id, editor_id, old_body) VALUES ($1, $2, $3)", [
        postId,
        viewer.id,
        r.body,
      ]);
      await client.query(
        `UPDATE posts SET body = $2, body_html = $3, markup_version = $4, edited_at = NOW(), edited_by = $5
          WHERE id = $1`,
        [postId, body, ctx.renderMarkup(body), MARKUP_VERSION, viewer.id]
      );
    }
    if (title !== null) {
      await client.query("UPDATE threads SET title = $2 WHERE id = $1", [r.thread_id, title]);
    }
  });
}

export interface PostVersion {
  bodyHtml: string;
  /** When this version was replaced; null for the current version. */
  replacedAt: Date | null;
  replacedByName: string | null;
}

/** Every version of a post, newest (current) first. */
export async function postHistory(
  ctx: ForumContext,
  viewer: Viewer | null,
  postId: number
): Promise<{ post: Awaited<ReturnType<typeof getPost>>; versions: PostVersion[] }> {
  const post = await getPost(ctx, viewer, postId);
  if (!canSeeEditHistory(viewer, post)) throw notFound("That page");
  const { rows } = await ctx.pool.query<{ old_body: string; edited_at: Date; editor_name: string }>(
    `SELECT e.old_body, e.edited_at, u.username AS editor_name
       FROM post_edits e JOIN users u ON u.id = e.editor_id
      WHERE e.post_id = $1
      ORDER BY e.id DESC`,
    [postId]
  );
  return {
    post,
    versions: [
      { bodyHtml: post.bodyHtml, replacedAt: null, replacedByName: null },
      ...rows.map((r) => ({
        bodyHtml: ctx.renderMarkup(r.old_body),
        replacedAt: r.edited_at,
        replacedByName: r.editor_name,
      })),
    ],
  };
}
