import { config } from "../config.js";
import { getBoard } from "./boards.js";
import type { ForumContext } from "./context.js";
import type { Board } from "./types.js";

export interface FeedItem {
  threadId: number;
  title: string;
  authorName: string;
  createdAt: Date;
  /** The first post, or null if a moderator removed it. */
  bodyHtml: string | null;
}

/**
 * A board's newest threads, for RSS. Always built as an anonymous visitor
 * would see it: feed readers carry no session, and the members-only board
 * has no feed.
 */
export async function boardFeed(ctx: ForumContext, slug: string): Promise<{ board: Board; items: FeedItem[] }> {
  const board = await getBoard(ctx, null, slug);
  const { rows } = await ctx.pool.query<{
    id: number;
    title: string;
    username: string;
    created_at: Date;
    body_html: string;
    deleted_at: Date | null;
  }>(
    `SELECT t.id, t.title, u.username, t.created_at, p.body_html, p.deleted_at
       FROM threads t
       JOIN users u ON u.id = t.author_id
       JOIN posts p ON p.id = t.first_post_id
      WHERE t.board_id = $1 AND t.deleted_at IS NULL
      ORDER BY t.created_at DESC
      LIMIT $2`,
    [board.id, config.pagination.rss_items]
  );
  return {
    board,
    items: rows.map((r) => ({
      threadId: r.id,
      title: r.title,
      authorName: r.username,
      createdAt: r.created_at,
      bodyHtml: r.deleted_at ? null : r.body_html,
    })),
  };
}
