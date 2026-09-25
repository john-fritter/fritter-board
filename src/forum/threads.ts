import type { PoolClient } from "pg";
import { config } from "../config.js";
import { withTransaction } from "../db/index.js";
import { MARKUP_VERSION } from "../markup/bbcode.js";
import { pageOf, paginate, type Page } from "../lib/pagination.js";
import { authorColumns, toAuthor, type AuthorRow } from "./authors.js";
import type { ForumContext } from "./context.js";
import { forbidden, notFound } from "./errors.js";
import { canPost, canReply, canSeeBoard } from "./permissions.js";
import type { Post, Thread, Viewer } from "./types.js";
import { validatePostBody, validateThreadTitle } from "./validate.js";

interface ThreadRow {
  id: number;
  title: string;
  author_id: number;
  reply_count: number;
  sticky: boolean;
  locked: boolean;
  created_at: Date;
  board_id: number;
  board_slug: string;
  board_name: string;
  board_description: string;
  board_members_only: boolean;
  board_thread_count: number;
}

const THREAD_SELECT = `
  SELECT t.id, t.title, t.author_id, t.reply_count, t.sticky, t.locked, t.created_at,
         b.id AS board_id, b.slug AS board_slug, b.name AS board_name,
         b.description AS board_description, b.members_only AS board_members_only,
         b.thread_count AS board_thread_count
    FROM threads t
    JOIN boards b ON b.id = t.board_id
   WHERE t.id = $1 AND t.deleted_at IS NULL AND b.deleted_at IS NULL`;

function toThread(r: ThreadRow): Thread {
  return {
    id: r.id,
    title: r.title,
    authorId: r.author_id,
    replyCount: r.reply_count,
    sticky: r.sticky,
    locked: r.locked,
    createdAt: r.created_at,
    board: {
      id: r.board_id,
      slug: r.board_slug,
      name: r.board_name,
      description: r.board_description,
      membersOnly: r.board_members_only,
      threadCount: r.board_thread_count,
    },
  };
}

export async function getThread(ctx: ForumContext, viewer: Viewer | null, threadId: number): Promise<Thread> {
  const { rows } = await ctx.pool.query<ThreadRow>(THREAD_SELECT, [threadId]);
  const thread = rows[0] && toThread(rows[0]);
  if (!thread || !canSeeBoard(viewer, thread.board)) throw notFound("That thread");
  return thread;
}

/** Posts in a thread, flat and chronological. Removed posts keep their slot. */
export async function listPosts(
  ctx: ForumContext,
  thread: Thread,
  rawPage: string | number | undefined
): Promise<{ posts: Post[]; page: Page }> {
  const page = paginate(rawPage, thread.replyCount + 1, config.pagination.posts_per_page);
  const { rows } = await ctx.pool.query<
    AuthorRow & {
      id: number;
      body: string;
      body_html: string;
      created_at: Date;
      edited_at: Date | null;
      edited_by_name: string | null;
      deleted_at: Date | null;
      delete_reason: string | null;
    }
  >(
    `SELECT p.id, p.body, p.body_html, p.created_at, p.edited_at, p.deleted_at, p.delete_reason,
            eu.username AS edited_by_name,
            ${authorColumns("a")}
       FROM posts p
       JOIN users a ON a.id = p.author_id
       LEFT JOIN users eu ON eu.id = p.edited_by
      WHERE p.thread_id = $1
      ORDER BY p.id
      LIMIT $2 OFFSET $3`,
    [thread.id, page.perPage, page.offset]
  );
  return {
    page,
    posts: rows.map((r, i) => ({
      id: r.id,
      threadId: thread.id,
      number: page.offset + i + 1,
      author: toAuthor(r),
      body: r.body,
      bodyHtml: r.body_html,
      createdAt: r.created_at,
      editedAt: r.edited_at,
      editedByName: r.edited_by_name,
      deleted: r.deleted_at !== null,
      deleteReason: r.delete_reason,
    })),
  };
}

/** Writes a post and keeps every denormalized count in step, in the caller's transaction. */
async function insertPost(
  ctx: ForumContext,
  client: PoolClient,
  opts: { threadId: number; boardId: number; authorId: number; body: string }
): Promise<{ id: number; createdAt: Date }> {
  const { rows } = await client.query<{ id: number; created_at: Date }>(
    `INSERT INTO posts (thread_id, author_id, body, body_html, markup_version)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, created_at`,
    [opts.threadId, opts.authorId, opts.body, ctx.renderMarkup(opts.body), MARKUP_VERSION]
  );
  const post = rows[0]!;
  await client.query("UPDATE boards SET post_count = post_count + 1 WHERE id = $1", [opts.boardId]);
  await client.query("UPDATE users SET post_count = post_count + 1 WHERE id = $1", [opts.authorId]);
  return { id: post.id, createdAt: post.created_at };
}

export async function createThread(
  ctx: ForumContext,
  viewer: Viewer | null,
  boardId: number,
  rawTitle: string,
  rawBody: string
): Promise<{ threadId: number; postId: number }> {
  if (!canPost(viewer)) throw forbidden("Only members can start threads.");
  const title = validateThreadTitle(rawTitle);
  const body = validatePostBody(rawBody);

  return withTransaction(ctx.pool, async (client) => {
    const { rows: boards } = await client.query<{ members_only: boolean }>(
      "SELECT members_only FROM boards WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
      [boardId]
    );
    const board = boards[0];
    if (!board || !canSeeBoard(viewer, { membersOnly: board.members_only })) throw notFound("That board");

    const { rows } = await client.query<{ id: number }>(
      "INSERT INTO threads (board_id, author_id, title) VALUES ($1, $2, $3) RETURNING id",
      [boardId, viewer.id, title]
    );
    const threadId = rows[0]!.id;
    const post = await insertPost(ctx, client, { threadId, boardId, authorId: viewer.id, body });
    await client.query(
      `UPDATE threads SET first_post_id = $2, last_post_id = $2, last_post_at = $3, created_at = $3
        WHERE id = $1`,
      [threadId, post.id, post.createdAt]
    );
    await client.query("UPDATE boards SET thread_count = thread_count + 1 WHERE id = $1", [boardId]);
    return { threadId, postId: post.id };
  });
}

export async function reply(
  ctx: ForumContext,
  viewer: Viewer | null,
  threadId: number,
  rawBody: string
): Promise<{ postId: number }> {
  if (!canPost(viewer)) throw forbidden("Only members can reply.");
  const body = validatePostBody(rawBody);

  return withTransaction(ctx.pool, async (client) => {
    // Locking the thread row serializes replies, so counts can't drift.
    const { rows } = await client.query<ThreadRow>(`${THREAD_SELECT} FOR UPDATE OF t`, [threadId]);
    const thread = rows[0] && toThread(rows[0]);
    if (!thread || !canSeeBoard(viewer, thread.board)) throw notFound("That thread");
    if (!canReply(viewer, thread)) throw forbidden("This thread is locked.");

    const post = await insertPost(ctx, client, {
      threadId,
      boardId: thread.board.id,
      authorId: viewer.id,
      body,
    });
    await client.query(
      `UPDATE threads SET last_post_id = $2, last_post_at = $3, reply_count = reply_count + 1
        WHERE id = $1`,
      [threadId, post.id, post.createdAt]
    );
    return { postId: post.id };
  });
}

export interface VisiblePost {
  id: number;
  threadId: number;
  threadTitle: string;
  threadLocked: boolean;
  isFirstPost: boolean;
  boardId: number;
  boardSlug: string;
  boardName: string;
  authorId: number;
  authorName: string;
  body: string;
  bodyHtml: string;
  createdAt: Date;
  deleted: boolean;
  deleteReason: string | null;
  /** 1-based position within the thread. */
  position: number;
}

/** A single post, if the viewer may see the thread it's in. */
export async function getPost(ctx: ForumContext, viewer: Viewer | null, postId: number): Promise<VisiblePost> {
  const { rows } = await ctx.pool.query<{
    id: number;
    thread_id: number;
    thread_title: string;
    locked: boolean;
    first_post_id: number;
    board_id: number;
    board_slug: string;
    board_name: string;
    author_id: number;
    author_name: string;
    body: string;
    body_html: string;
    created_at: Date;
    deleted_at: Date | null;
    delete_reason: string | null;
    members_only: boolean;
    position: number;
  }>(
    `SELECT p.id, p.thread_id, t.title AS thread_title, t.locked, t.first_post_id,
            b.id AS board_id, b.slug AS board_slug, b.name AS board_name,
            p.author_id, u.username AS author_name, p.body, p.body_html, p.created_at,
            p.deleted_at, p.delete_reason, b.members_only,
            (SELECT COUNT(*) FROM posts q WHERE q.thread_id = p.thread_id AND q.id <= p.id) AS position
       FROM posts p
       JOIN users u ON u.id = p.author_id
       JOIN threads t ON t.id = p.thread_id
       JOIN boards b ON b.id = t.board_id
      WHERE p.id = $1 AND t.deleted_at IS NULL AND b.deleted_at IS NULL`,
    [postId]
  );
  const r = rows[0];
  if (!r || !canSeeBoard(viewer, { membersOnly: r.members_only })) throw notFound("That post");
  return {
    id: r.id,
    threadId: r.thread_id,
    threadTitle: r.thread_title,
    threadLocked: r.locked,
    isFirstPost: r.first_post_id === r.id,
    boardId: r.board_id,
    boardSlug: r.board_slug,
    boardName: r.board_name,
    authorId: r.author_id,
    authorName: r.author_name,
    body: r.body,
    bodyHtml: r.body_html,
    createdAt: r.created_at,
    deleted: r.deleted_at !== null,
    deleteReason: r.delete_reason,
    position: r.position,
  };
}

/** Where a post permalink should land: its thread and the page it's on. */
export async function locatePost(
  ctx: ForumContext,
  viewer: Viewer | null,
  postId: number
): Promise<{ threadId: number; page: number }> {
  const post = await getPost(ctx, viewer, postId);
  return { threadId: post.threadId, page: pageOf(post.position, config.pagination.posts_per_page) };
}
