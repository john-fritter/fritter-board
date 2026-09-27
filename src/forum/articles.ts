import { config } from "../config.js";
import {
  getArticle,
  getArticleSources,
  listArticlesSince,
  searchArticles,
  type FpArticle,
  type FpArticleSummary,
  type FpSource,
} from "../fp/articles.js";
import { paginate, type Page } from "../lib/pagination.js";
import type { ForumContext } from "./context.js";
import { invalid, notFound } from "./errors.js";
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

/** The ids of the visible threads discussing these articles, by article. */
async function visibleThreadsFor(
  ctx: ForumContext,
  viewer: Viewer | null,
  articleIds: number[]
): Promise<Map<number, number>> {
  if (articleIds.length === 0) return new Map();
  const { rows } = await ctx.pool.query<{ fp_article_id: number; id: number }>(
    `SELECT t.fp_article_id, t.id
       FROM threads t
       JOIN boards b ON b.id = t.board_id
      WHERE t.fp_article_id = ANY($1::bigint[]) AND t.deleted_at IS NULL AND ${visibleBoardsSql(viewer)}`,
    [articleIds]
  );
  return new Map(rows.map((r) => [r.fp_article_id, r.id]));
}

/** An article in full, with the Researcher's sources and its thread if the viewer can see one. */
export async function readArticle(
  ctx: ForumContext,
  viewer: Viewer | null,
  articleId: number
): Promise<{ article: FpArticle; sources: FpSource[]; threadId: number | null }> {
  const { article, threadId } = await articleDiscussion(ctx, viewer, articleId);
  const sources = ctx.fp ? await getArticleSources(ctx.fp, articleId) : [];
  return { article, sources, threadId };
}

export interface ArticleListing {
  article: FpArticleSummary;
  /** Its discussion, if there is one the viewer can see. */
  threadId: number | null;
}

/**
 * What the paper published since a moment, with each article's thread. Null
 * when the paper can't be read: callers carry on without it, as thread pages do.
 */
export async function articlesSince(
  ctx: ForumContext,
  viewer: Viewer | null,
  since: Date,
  limit: number
): Promise<ArticleListing[] | null> {
  if (!ctx.fp) return null;
  let articles: FpArticleSummary[];
  try {
    articles = await listArticlesSince(ctx.fp, since, limit);
  } catch (err) {
    console.error("Fritter Post articles could not be listed:", err);
    return null;
  }
  const threads = await visibleThreadsFor(ctx, viewer, articles.map((a) => a.id));
  return articles.map((article) => ({ article, threadId: threads.get(article.id) ?? null }));
}

/** Full-text search over the paper. A 404 when the board runs without it. */
export async function searchPaper(
  ctx: ForumContext,
  viewer: Viewer | null,
  q: string,
  rawPage: string | number | undefined
): Promise<{ hits: ArticleListing[]; page: Page; total: number }> {
  if (!ctx.fp) throw invalid("This board isn't connected to the paper.");
  const perPage = config.pagination.search_results_per_page;
  const wanted = paginate(rawPage, Number.MAX_SAFE_INTEGER, perPage);
  if (q.trim() === "") return { hits: [], page: paginate(1, 0, perPage), total: 0 };
  const { articles, total } = await searchArticles(ctx.fp, q.trim(), perPage, wanted.offset);
  const threads = await visibleThreadsFor(ctx, viewer, articles.map((a) => a.id));
  return {
    total,
    page: paginate(wanted.page, total, perPage),
    hits: articles.map((article) => ({ article, threadId: threads.get(article.id) ?? null })),
  };
}
