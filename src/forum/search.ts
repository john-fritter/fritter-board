import { config } from "../config.js";
import { escapeHtml } from "../markup/bbcode.js";
import { paginate, type Page } from "../lib/pagination.js";
import { getBoard } from "./boards.js";
import type { ForumContext } from "./context.js";
import { visibleBoardsSql } from "./permissions.js";
import type { Viewer } from "./types.js";

export interface SearchQuery {
  /** Words to find, in web-search syntax: "quoted phrases", -excluded, or. */
  q: string;
  boardSlug?: string;
  author?: string;
  sort?: "newest" | "relevance";
}

export interface SearchHit {
  postId: number;
  threadId: number;
  threadTitle: string;
  boardName: string;
  authorName: string;
  createdAt: Date;
  /** Escaped excerpt with matches wrapped in <mark>. */
  snippetHtml: string;
}

// Postgres marks matches with these private-use characters; they are
// stripped from the source first, so after escaping they can only be ours.
const START = "";
const STOP = "";
const HEADLINE_OPTIONS = `StartSel=${START}, StopSel=${STOP}, MaxWords=40, MinWords=15, MaxFragments=2, FragmentDelimiter=" … "`;
// Search excerpts show text, not markup.
const PLAIN_BODY = String.raw`regexp_replace(regexp_replace(p.body, '\[/?[a-z]+(=[^\]\n]*)?\]', ' ', 'gi'), '[]', '', 'g')`;
const EXCERPT_CHARS = 300;

function snippetToHtml(raw: string): string {
  return escapeHtml(raw).replaceAll(START, "<mark>").replaceAll(STOP, "</mark>").replace(/\s+/g, " ").trim();
}

/**
 * Full-text search over posts, where a match on a thread's title counts as a
 * match on its first post. Only boards the viewer can see are searched, and
 * removed posts never appear. With no words but an author, lists that
 * member's posts — the bots' "what have I said before" lookup.
 */
export async function search(
  ctx: ForumContext,
  viewer: Viewer | null,
  query: SearchQuery,
  rawPage: string | undefined
): Promise<{ hits: SearchHit[]; page: Page; total: number }> {
  const q = query.q.trim();
  const author = query.author?.trim() ?? "";
  const empty = { hits: [], page: paginate(1, 0, config.pagination.search_results_per_page), total: 0 };
  if (q === "" && author === "") return empty;

  const params: unknown[] = [];
  const param = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where = [
    "p.deleted_at IS NULL",
    "t.deleted_at IS NULL",
    visibleBoardsSql(viewer),
  ];
  const tsq = q === "" ? null : `websearch_to_tsquery('english', ${param(q)})`;
  if (tsq) where.push(`(p.search_vector @@ ${tsq} OR (p.id = t.first_post_id AND t.search_vector @@ ${tsq}))`);
  if (query.boardSlug) {
    const board = await getBoard(ctx, viewer, query.boardSlug); // 404s for a board the viewer can't see
    where.push(`b.id = ${param(board.id)}`);
  }
  if (author !== "") where.push(`LOWER(u.username) = LOWER(${param(author)})`);

  const from = `
    FROM posts p
    JOIN threads t ON t.id = p.thread_id
    JOIN boards b ON b.id = t.board_id
    JOIN users u ON u.id = p.author_id
   WHERE ${where.join(" AND ")}`;

  const { rows: count } = await ctx.pool.query<{ n: number }>(`SELECT COUNT(*) AS n ${from}`, params);
  const total = count[0]!.n;
  const page = paginate(rawPage, total, config.pagination.search_results_per_page);

  const snippet = tsq
    ? `ts_headline('english', ${PLAIN_BODY}, ${tsq}, ${param(HEADLINE_OPTIONS)})`
    : `LEFT(${PLAIN_BODY}, ${EXCERPT_CHARS})`;
  const order =
    tsq && query.sort === "relevance"
      ? `ts_rank(p.search_vector, ${tsq}) + ts_rank(t.search_vector, ${tsq}) DESC, p.id DESC`
      : "p.id DESC";
  const { rows } = await ctx.pool.query<{
    id: number;
    thread_id: number;
    title: string;
    board_name: string;
    username: string;
    created_at: Date;
    snippet: string;
  }>(
    `SELECT p.id, p.thread_id, t.title, b.name AS board_name, u.username, p.created_at, ${snippet} AS snippet
     ${from}
     ORDER BY ${order}
     LIMIT ${param(page.perPage)} OFFSET ${param(page.offset)}`,
    params
  );
  return {
    total,
    page,
    hits: rows.map((r) => ({
      postId: r.id,
      threadId: r.thread_id,
      threadTitle: r.title,
      boardName: r.board_name,
      authorName: r.username,
      createdAt: r.created_at,
      snippetHtml: snippetToHtml(r.snippet),
    })),
  };
}
