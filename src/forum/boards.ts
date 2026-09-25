import { config } from "../config.js";
import { paginate, type Page } from "../lib/pagination.js";
import type { ForumContext } from "./context.js";
import { notFound } from "./errors.js";
import { canSeeBoard, visibleBoardsSql } from "./permissions.js";
import { unreadSql } from "./reads.js";
import type { Board, CategoryWithBoards, ThreadListItem, Viewer } from "./types.js";

/** The front page: every visible board, grouped by category, with its latest post. */
export async function listIndex(ctx: ForumContext, viewer: Viewer | null): Promise<CategoryWithBoards[]> {
  const { rows } = await ctx.pool.query<{
    category_id: number;
    category_name: string;
    id: number;
    slug: string;
    name: string;
    description: string;
    members_only: boolean;
    thread_count: number;
    post_count: number;
    lp_thread_id: number | null;
    lp_title: string | null;
    lp_post_id: number | null;
    lp_at: Date | null;
    lp_author: string | null;
    unread: boolean;
  }>(
    `SELECT c.id AS category_id, c.name AS category_name,
            b.id, b.slug, b.name, b.description, b.members_only, b.thread_count, b.post_count,
            lp.thread_id AS lp_thread_id, lp.title AS lp_title, lp.post_id AS lp_post_id,
            lp.at AS lp_at, lp.author AS lp_author,
            EXISTS (SELECT 1 FROM threads t
                     WHERE t.board_id = b.id AND t.deleted_at IS NULL AND ${unreadSql("t", "$1")}) AS unread
       FROM categories c
       JOIN boards b ON b.category_id = c.id
       LEFT JOIN LATERAL (
         SELECT t.id AS thread_id, t.title, t.last_post_id AS post_id,
                t.last_post_at AS at, u.username AS author
           FROM threads t
           JOIN posts p ON p.id = t.last_post_id
           JOIN users u ON u.id = p.author_id
          WHERE t.board_id = b.id AND t.deleted_at IS NULL
          ORDER BY t.last_post_at DESC
          LIMIT 1
       ) lp ON TRUE
      WHERE c.deleted_at IS NULL AND ${visibleBoardsSql(viewer)}
      ORDER BY c.sort_order, c.id, b.sort_order, b.id`,
    [viewer?.id ?? null]
  );

  const categories: CategoryWithBoards[] = [];
  for (const row of rows) {
    let cat = categories[categories.length - 1];
    if (!cat || cat.id !== row.category_id) {
      cat = { id: row.category_id, name: row.category_name, boards: [] };
      categories.push(cat);
    }
    cat.boards.push({
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      membersOnly: row.members_only,
      threadCount: row.thread_count,
      postCount: row.post_count,
      unread: row.unread,
      lastPost:
        row.lp_thread_id !== null
          ? {
              threadId: row.lp_thread_id,
              threadTitle: row.lp_title!,
              postId: row.lp_post_id!,
              at: row.lp_at!,
              authorName: row.lp_author!,
            }
          : null,
    });
  }
  return categories;
}

export async function getBoard(ctx: ForumContext, viewer: Viewer | null, slug: string): Promise<Board> {
  const { rows } = await ctx.pool.query<{
    id: number;
    slug: string;
    name: string;
    description: string;
    members_only: boolean;
    thread_count: number;
  }>(
    `SELECT id, slug, name, description, members_only, thread_count
       FROM boards WHERE slug = $1 AND deleted_at IS NULL`,
    [slug]
  );
  const row = rows[0];
  const board = row && {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    membersOnly: row.members_only,
    threadCount: row.thread_count,
  };
  if (!board || !canSeeBoard(viewer, board)) throw notFound("That board");
  return board;
}

/** A board's threads: stickies first, then by last reply. */
export async function listThreads(
  ctx: ForumContext,
  viewer: Viewer | null,
  board: Board,
  rawPage: string | undefined
): Promise<{ threads: ThreadListItem[]; page: Page }> {
  const page = paginate(rawPage, board.threadCount, config.pagination.threads_per_page);
  const { rows } = await ctx.pool.query<{
    id: number;
    title: string;
    author_name: string;
    created_at: Date;
    reply_count: number;
    sticky: boolean;
    locked: boolean;
    last_post_id: number | null;
    last_post_at: Date;
    last_author_name: string | null;
    unread: boolean;
  }>(
    `SELECT t.id, t.title, au.username AS author_name, t.created_at, t.reply_count,
            t.sticky, t.locked, t.last_post_id, t.last_post_at, lu.username AS last_author_name,
            ${unreadSql("t", "$4")} AS unread
       FROM threads t
       JOIN users au ON au.id = t.author_id
       LEFT JOIN posts lp ON lp.id = t.last_post_id
       LEFT JOIN users lu ON lu.id = lp.author_id
      WHERE t.board_id = $1 AND t.deleted_at IS NULL
      ORDER BY t.sticky DESC, t.last_post_at DESC, t.id DESC
      LIMIT $2 OFFSET $3`,
    [board.id, page.perPage, page.offset, viewer?.id ?? null]
  );
  return {
    page,
    threads: rows.map((r) => ({
      id: r.id,
      title: r.title,
      authorName: r.author_name,
      createdAt: r.created_at,
      replyCount: r.reply_count,
      sticky: r.sticky,
      locked: r.locked,
      lastPostId: r.last_post_id,
      lastPostAt: r.last_post_at,
      lastPostAuthorName: r.last_author_name,
      unread: r.unread,
    })),
  };
}

/** Every board the viewer can see, in index order: for move and search pickers. */
export async function listVisibleBoards(
  ctx: ForumContext,
  viewer: Viewer | null
): Promise<{ slug: string; name: string }[]> {
  const { rows } = await ctx.pool.query<{ slug: string; name: string }>(
    `SELECT b.slug, b.name FROM boards b JOIN categories c ON c.id = b.category_id
      WHERE c.deleted_at IS NULL AND ${visibleBoardsSql(viewer)}
      ORDER BY c.sort_order, c.id, b.sort_order, b.id`
  );
  return rows;
}
