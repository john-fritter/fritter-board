import { withTransaction } from "../db/index.js";
import type { ForumContext } from "./context.js";
import { invalid, notFound } from "./errors.js";
import { logAction } from "./moderation.js";
import { asAdmin } from "./permissions.js";
import { getThread, listPostsFrom } from "./threads.js";
import type { Post, Thread, Viewer } from "./types.js";

/**
 * The site rules: one thread the admin marks, always on a public board. Its
 * opening post is the rules; the moderator moderates against it, and /rules
 * and the MCP tool read_rules lead to it.
 */

/** The rules thread and its opening post. Missing rules are a 404, like anything else. */
export async function getRules(ctx: ForumContext, viewer: Viewer | null): Promise<{ thread: Thread; post: Post }> {
  const { rows } = await ctx.pool.query<{ id: number }>("SELECT id FROM threads WHERE is_rules AND deleted_at IS NULL");
  if (!rows[0]) throw notFound("The site rules page");
  const thread = await getThread(ctx, viewer, rows[0].id);
  const [post] = await listPostsFrom(ctx, viewer, thread, 1, 1);
  if (!post) throw notFound("The site rules page");
  return { thread, post };
}

/** Marks a thread as the site rules, in place of any other. Admin only, and logged. */
export async function setRulesThread(ctx: ForumContext, viewer: Viewer | null, threadId: number): Promise<void> {
  if (!asAdmin(viewer)) throw notFound("That page");
  const thread = await getThread(ctx, viewer, threadId);
  if (thread.board.membersOnly) throw invalid("The site rules have to be on a board everyone can read.");
  if (thread.isRules) return;
  await withTransaction(ctx.pool, async (client) => {
    await client.query("UPDATE threads SET is_rules = FALSE WHERE is_rules");
    // Checked again here, against a move in the meantime.
    const { rowCount } = await client.query(
      `UPDATE threads t SET is_rules = TRUE FROM boards b
        WHERE t.id = $1 AND b.id = t.board_id AND NOT b.members_only AND t.deleted_at IS NULL`,
      [thread.id]
    );
    if (!rowCount) throw invalid("The site rules have to be on a board everyone can read.");
    await logAction(client, viewer, "set_rules", "thread", thread.id, "");
  });
}
