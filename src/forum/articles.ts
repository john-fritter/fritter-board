import { getArticle, type FpArticle } from "../fp/articles.js";
import type { ForumContext } from "./context.js";
import { notFound } from "./errors.js";
import { visibleBoardsSql } from "./permissions.js";
import type { Viewer } from "./types.js";

/**
 * Fritter Post articles on the board. Articles themselves are public — the
 * paper is — so what needs a permission check is the thread: an article's
 * thread may have been moved into the Back Room, and then it doesn't exist as
 * far as a visitor can tell. The article page must not reveal it either.
 */

/** The article, or a 404 when the board has no paper or the paper has no such article. */
export async function requireArticle(ctx: ForumContext, articleId: number): Promise<FpArticle> {
  const article = ctx.fp ? await getArticle(ctx.fp, articleId) : null;
  if (!article) throw notFound("That article");
  return article;
}

/** An article and its thread, if there is one the viewer can see. */
export async function articleDiscussion(
  ctx: ForumContext,
  viewer: Viewer | null,
  articleId: number
): Promise<{ article: FpArticle; threadId: number | null }> {
  const article = await requireArticle(ctx, articleId);
  const { rows } = await ctx.pool.query<{ id: number }>(
    `SELECT t.id
       FROM threads t
       JOIN boards b ON b.id = t.board_id
      WHERE t.fp_article_id = $1 AND t.deleted_at IS NULL AND ${visibleBoardsSql(viewer)}`,
    [articleId]
  );
  return { article, threadId: rows[0]?.id ?? null };
}

export type ThreadArticle =
  | { state: "ok"; article: FpArticle }
  /** No published paper carries it any more (replaced from a different run). */
  | { state: "gone" }
  /** The paper couldn't be read just now, or this board runs without it. */
  | { state: "unavailable" };

/**
 * The article card for a thread. Never throws: the thread is the board's and
 * must render whatever state the paper is in.
 */
export async function articleForThread(ctx: ForumContext, articleId: number): Promise<ThreadArticle> {
  if (!ctx.fp) return { state: "unavailable" };
  try {
    const article = await getArticle(ctx.fp, articleId);
    return article ? { state: "ok", article } : { state: "gone" };
  } catch (err) {
    console.error(`Fritter Post article ${articleId} could not be read:`, err);
    return { state: "unavailable" };
  }
}
