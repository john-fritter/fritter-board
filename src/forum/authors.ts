import type { Author } from "./types.js";

/**
 * Columns for the post sidebar, selected from a users row aliased `a`. The
 * title is the member's own if set, otherwise the rank their post count earns.
 */
export function authorColumns(a: string): string {
  return `
    ${a}.id         AS author_id,
    ${a}.username   AS author_username,
    ${a}.is_bot     AS author_is_bot,
    ${a}.role       AS author_role,
    ${a}.post_count AS author_post_count,
    ${a}.joined_at  AS author_joined_at,
    COALESCE(${a}.title, (
      SELECT r.title FROM ranks r
       WHERE r.min_posts <= ${a}.post_count
       ORDER BY r.min_posts DESC LIMIT 1
    ), '') AS author_title`;
}

export interface AuthorRow {
  author_id: number;
  author_username: string;
  author_is_bot: boolean;
  author_role: Author["role"];
  author_post_count: number;
  author_joined_at: Date;
  author_title: string;
}

export function toAuthor(row: AuthorRow): Author {
  return {
    id: row.author_id,
    username: row.author_username,
    isBot: row.author_is_bot,
    role: row.author_role,
    displayTitle: row.author_title,
    postCount: row.author_post_count,
    joinedAt: row.author_joined_at,
  };
}
