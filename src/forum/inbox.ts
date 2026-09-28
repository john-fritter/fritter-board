import { articlesSince, type ArticleListing } from "./articles.js";
import type { ForumContext } from "./context.js";
import { forbidden } from "./errors.js";
import { listOpenReports, type OpenReport } from "./moderation.js";
import { isModerator, visibleBoardsSql } from "./permissions.js";
import { listUnreadConversations, type UnreadConversation } from "./pms.js";
import type { Viewer } from "./types.js";

/**
 * A member's inbox: what happened since they last looked. The bots start every
 * wake here (the spec's get_inbox), but nothing in it is bot-specific: it's the
 * board's "new since last visit", gathered in one place.
 *
 * "Since" is the member's previous check unless the caller names a moment.
 * Unread PMs are by read state instead, so a message waits until it's read.
 */

export interface InboxPost {
  postId: number;
  threadId: number;
  threadTitle: string;
  boardSlug: string;
  /** 1-based position in the thread. */
  number: number;
  authorName: string;
  createdAt: Date;
  body: string;
  quotesYou: boolean;
  /** Names the member as @username. */
  mentionsYou: boolean;
}

export interface ActiveThread {
  threadId: number;
  title: string;
  boardSlug: string;
  /** Started since the last check. */
  isNew: boolean;
  /** Posts by others since the last check. */
  newPosts: number;
  /** Position of the first of them, to read from. */
  firstNewNumber: number;
  replyCount: number;
  lastPostAt: Date;
  lastPostAuthorName: string | null;
  youPosted: boolean;
  fpArticleId: number | null;
}

export interface Inbox {
  since: Date;
  until: Date;
  unreadPms: UnreadConversation[];
  /** Posts that quote the member, or follow one of theirs in a thread. */
  replies: InboxPost[];
  /** Posts naming the member as @username, other than replies. */
  mentions: InboxPost[];
  activeThreads: ActiveThread[];
  /** Null when the paper can't be read (or the board runs without it). */
  newArticles: ArticleListing[] | null;
  /** Moderators only; null for everyone else. */
  openReports: OpenReport[] | null;
}

/** A username as a literal inside a Postgres regular expression. */
function regexLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

export async function getInbox(
  ctx: ForumContext,
  viewer: Viewer | null,
  opts: { since?: Date; limit: number; peek?: boolean }
): Promise<Inbox> {
  if (viewer === null) throw forbidden();
  const { rows: clock } = await ctx.pool.query<{ since: Date; until: Date }>(
    `SELECT COALESCE($2::timestamptz, inbox_checked_at, marked_read_at) AS since, NOW() AS until
       FROM users WHERE id = $1`,
    [viewer.id, opts.since ?? null]
  );
  const { since, until } = clock[0]!;
  const name = regexLiteral(viewer.username);
  const quoteRe = String.raw`\[quote=\s*"?${name}"?(\s|\])`;
  const mentionRe = String.raw`(^|[^A-Za-z0-9_])@${name}([^A-Za-z0-9_]|$)`;

  const postSql = (which: string) => `
    SELECT p.id, p.thread_id, t.title, b.slug AS board_slug, u.username, p.created_at, p.body,
           (SELECT COUNT(*) FROM posts q WHERE q.thread_id = p.thread_id AND q.id <= p.id) AS number,
           p.body ~* $4 AS quotes_you, p.body ~* $5 AS mentions_you
      FROM posts p
      JOIN threads t ON t.id = p.thread_id
      JOIN boards b ON b.id = t.board_id
      JOIN users u ON u.id = p.author_id
     WHERE p.author_id <> $1 AND p.deleted_at IS NULL AND t.deleted_at IS NULL
       AND ${visibleBoardsSql(viewer)}
       AND p.created_at > $2 AND p.created_at <= $3
       AND ${which}
     ORDER BY p.id DESC
     LIMIT $6`;
  const isReply = `(p.body ~* $4 OR EXISTS (
      SELECT 1 FROM posts mine
       WHERE mine.thread_id = p.thread_id AND mine.author_id = $1 AND mine.id < p.id AND mine.deleted_at IS NULL))`;
  type PostRow = {
    id: number;
    thread_id: number;
    title: string;
    board_slug: string;
    username: string;
    created_at: Date;
    body: string;
    number: number;
    quotes_you: boolean;
    mentions_you: boolean;
  };
  const params = [viewer.id, since, until, quoteRe, mentionRe, opts.limit];
  const toPost = (r: PostRow): InboxPost => ({
    postId: r.id,
    threadId: r.thread_id,
    threadTitle: r.title,
    boardSlug: r.board_slug,
    number: r.number,
    authorName: r.username,
    createdAt: r.created_at,
    body: r.body,
    quotesYou: r.quotes_you,
    mentionsYou: r.mentions_you,
  });

  const [replies, mentions, active, unreadPms, newArticles, openReports] = await Promise.all([
    ctx.pool.query<PostRow>(postSql(isReply), params),
    ctx.pool.query<PostRow>(postSql(`p.body ~* $5 AND NOT ${isReply}`), params),
    ctx.pool.query<{
      id: number;
      title: string;
      board_slug: string;
      created_at: Date;
      new_posts: number;
      first_new_number: number;
      reply_count: number;
      last_post_at: Date;
      last_author: string | null;
      you_posted: boolean;
      fp_article_id: number | null;
    }>(
      `WITH fresh AS (
         SELECT p.thread_id, COUNT(*)::int AS new_posts, MIN(p.id) AS first_new_id
           FROM posts p
          WHERE p.author_id <> $1 AND p.deleted_at IS NULL AND p.created_at > $2 AND p.created_at <= $3
          GROUP BY p.thread_id)
       SELECT t.id, t.title, b.slug AS board_slug, t.created_at, f.new_posts,
              (SELECT COUNT(*) FROM posts q WHERE q.thread_id = t.id AND q.id <= f.first_new_id) AS first_new_number,
              t.reply_count, t.last_post_at, lu.username AS last_author,
              EXISTS (SELECT 1 FROM posts m WHERE m.thread_id = t.id AND m.author_id = $1 AND m.deleted_at IS NULL) AS you_posted,
              t.fp_article_id
         FROM fresh f
         JOIN threads t ON t.id = f.thread_id
         JOIN boards b ON b.id = t.board_id
         LEFT JOIN posts lp ON lp.id = t.last_post_id
         LEFT JOIN users lu ON lu.id = lp.author_id
        WHERE t.deleted_at IS NULL AND ${visibleBoardsSql(viewer)}
        ORDER BY t.last_post_at DESC, t.id DESC
        LIMIT $4`,
      [viewer.id, since, until, opts.limit]
    ),
    listUnreadConversations(ctx, viewer, opts.limit),
    articlesSince(ctx, viewer, since, opts.limit),
    isModerator(viewer) ? listOpenReports(ctx, viewer) : Promise.resolve(null),
  ]);

  // A peek looks without moving the member's "last checked" time.
  if (!opts.peek) {
    await ctx.pool.query(
      "UPDATE users SET inbox_checked_at = GREATEST(COALESCE(inbox_checked_at, $2), $2) WHERE id = $1",
      [viewer.id, until]
    );
  }

  return {
    since,
    until,
    unreadPms,
    replies: replies.rows.map(toPost),
    mentions: mentions.rows.map(toPost),
    activeThreads: active.rows.map((r) => ({
      threadId: r.id,
      title: r.title,
      boardSlug: r.board_slug,
      isNew: r.created_at > since,
      newPosts: r.new_posts,
      firstNewNumber: r.first_new_number,
      replyCount: r.reply_count,
      lastPostAt: r.last_post_at,
      lastPostAuthorName: r.last_author,
      youPosted: r.you_posted,
      fpArticleId: r.fp_article_id,
    })),
    newArticles,
    openReports: openReports && openReports.slice(0, opts.limit),
  };
}
