import { config } from "../config.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { sha256 } from "../auth/tokens.js";
import { paginate, type Page } from "../lib/pagination.js";
import { authorColumns, toAuthor, type AuthorRow } from "./authors.js";
import type { ForumContext } from "./context.js";
import { forbidden, invalid, notFound } from "./errors.js";
import { isMember, visibleBoardsSql } from "./permissions.js";
import type { Author, Viewer } from "./types.js";
import { validateBio, validatePassword, validateUserTitle } from "./validate.js";

export interface Profile {
  author: Author;
  /** The member's own title, separate from the rank fallback in author.displayTitle. */
  customTitle: string | null;
  bio: string;
  bioHtml: string;
  lastSeenAt: Date | null;
}

export async function getProfile(ctx: ForumContext, username: string): Promise<Profile> {
  const { rows } = await ctx.pool.query<AuthorRow & { title: string | null; bio: string; last_seen_at: Date | null }>(
    `SELECT a.title, a.bio, a.last_seen_at, ${authorColumns("a")}
       FROM users a
      WHERE LOWER(a.username) = LOWER($1) AND a.deleted_at IS NULL`,
    [username]
  );
  const r = rows[0];
  if (!r) throw notFound("That member");
  return {
    author: toAuthor(r),
    customTitle: r.title,
    bio: r.bio,
    bioHtml: r.bio === "" ? "" : ctx.renderMarkup(r.bio),
    lastSeenAt: r.last_seen_at,
  };
}

export interface RecentPost {
  postId: number;
  threadId: number;
  threadTitle: string;
  boardName: string;
  createdAt: Date;
  bodyHtml: string;
}

/** A member's latest posts, limited to boards the viewer can see. */
export async function recentPosts(ctx: ForumContext, viewer: Viewer | null, userId: number): Promise<RecentPost[]> {
  const { rows } = await ctx.pool.query<{
    id: number;
    thread_id: number;
    thread_title: string;
    board_name: string;
    created_at: Date;
    body_html: string;
  }>(
    `SELECT p.id, p.thread_id, t.title AS thread_title, b.name AS board_name, p.created_at, p.body_html
       FROM posts p
       JOIN threads t ON t.id = p.thread_id
       JOIN boards b ON b.id = t.board_id
      WHERE p.author_id = $1 AND p.deleted_at IS NULL AND t.deleted_at IS NULL
        AND ${visibleBoardsSql(viewer)}
      ORDER BY p.id DESC
      LIMIT $2`,
    [userId, config.pagination.profile_recent_posts]
  );
  return rows.map((r) => ({
    postId: r.id,
    threadId: r.thread_id,
    threadTitle: r.thread_title,
    boardName: r.board_name,
    createdAt: r.created_at,
    bodyHtml: r.body_html,
  }));
}

export interface MemberListItem {
  author: Author;
  lastSeenAt: Date | null;
}

export async function listMembers(
  ctx: ForumContext,
  rawPage: string | undefined
): Promise<{ members: MemberListItem[]; page: Page }> {
  const { rows: countRows } = await ctx.pool.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL"
  );
  const page = paginate(rawPage, countRows[0]!.n, config.pagination.members_per_page);
  const { rows } = await ctx.pool.query<AuthorRow & { last_seen_at: Date | null }>(
    `SELECT a.last_seen_at, ${authorColumns("a")}
       FROM users a
      WHERE a.deleted_at IS NULL
      ORDER BY a.joined_at, a.id
      LIMIT $1 OFFSET $2`,
    [page.perPage, page.offset]
  );
  return { page, members: rows.map((r) => ({ author: toAuthor(r), lastSeenAt: r.last_seen_at })) };
}

/** Members (bots included) seen within the online window. */
export async function whoIsOnline(ctx: ForumContext): Promise<{ username: string; isBot: boolean }[]> {
  const { rows } = await ctx.pool.query<{ username: string; is_bot: boolean }>(
    `SELECT username, is_bot FROM users
      WHERE deleted_at IS NULL AND last_seen_at > NOW() - $1::float8 * INTERVAL '1 minute'
      ORDER BY LOWER(username)`,
    [config.online.window_minutes]
  );
  return rows.map((r) => ({ username: r.username, isBot: r.is_bot }));
}

export async function updateProfile(
  ctx: ForumContext,
  viewer: Viewer | null,
  input: { title: string; bio: string }
): Promise<void> {
  if (!isMember(viewer)) throw forbidden();
  const title = validateUserTitle(input.title);
  const bio = validateBio(input.bio);
  await ctx.pool.query(
    `UPDATE users
        SET bio = $2,
            title_changed_at = CASE WHEN title IS DISTINCT FROM $3 THEN NOW() ELSE title_changed_at END,
            title = $3
      WHERE id = $1`,
    [viewer.id, bio, title]
  );
}

/** Changes the viewer's password and ends every other session they have. */
export async function changePassword(
  ctx: ForumContext,
  viewer: Viewer | null,
  current: string,
  next: string,
  keepSessionToken: string
): Promise<void> {
  if (viewer === null) throw forbidden();
  const { rows } = await ctx.pool.query<{ password_hash: string | null }>(
    "SELECT password_hash FROM users WHERE id = $1",
    [viewer.id]
  );
  const hash = rows[0]?.password_hash;
  if (!hash || !(await verifyPassword(hash, current))) throw invalid("Your current password isn't right.");
  const newHash = await hashPassword(validatePassword(next));
  await ctx.pool.query("UPDATE users SET password_hash = $2 WHERE id = $1", [viewer.id, newHash]);
  await ctx.pool.query("DELETE FROM sessions WHERE user_id = $1 AND id <> $2", [
    viewer.id,
    sha256(keepSessionToken),
  ]);
}
