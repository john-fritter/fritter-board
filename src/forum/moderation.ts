import type { PoolClient } from "pg";
import { config } from "../config.js";
import { withTransaction } from "../db/index.js";
import { paginate, type Page } from "../lib/pagination.js";
import type { ForumContext } from "./context.js";
import { forbidden, invalid, notFound } from "./errors.js";
import {
  canChangeMemberStatus,
  canRemovePost,
  canRestorePost,
  canSeeBoard,
  isMember,
  asModerator,
} from "./permissions.js";
import { startConversationTx } from "./pms.js";
import type { UserStatus, Viewer } from "./types.js";
import { optionalReason, validateReason } from "./validate.js";

/**
 * Moderation. Every action writes a mod_actions row in the same transaction
 * as the change, and the mod log shows them all publicly. Who may do what
 * follows the spec: moderators handle threads, posts and warnings; reversing
 * a removal or changing anyone's membership needs the admin.
 */

export type ModAction =
  | "lock"
  | "unlock"
  | "sticky"
  | "unsticky"
  | "move"
  | "remove_post"
  | "restore_post"
  | "warn"
  | "suspend"
  | "ban"
  | "reinstate"
  | "resolve_report";

type TargetType = "thread" | "post" | "user" | "report";

async function logAction(
  client: PoolClient,
  moderator: Viewer,
  action: ModAction,
  targetType: TargetType,
  targetId: number,
  reason: string,
  details: Record<string, unknown> = {}
): Promise<void> {
  await client.query(
    `INSERT INTO mod_actions (moderator_id, action, target_type, target_id, reason, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [moderator.id, action, targetType, targetId, reason, details]
  );
}

/** Locks the thread row for a moderator action and returns its current state. */
async function lockThreadForMod(client: PoolClient, threadId: number) {
  const { rows } = await client.query<{
    id: number;
    board_id: number;
    locked: boolean;
    sticky: boolean;
    reply_count: number;
  }>(
    `SELECT t.id, t.board_id, t.locked, t.sticky, t.reply_count
       FROM threads t JOIN boards b ON b.id = t.board_id
      WHERE t.id = $1 AND t.deleted_at IS NULL AND b.deleted_at IS NULL
      FOR UPDATE OF t`,
    [threadId]
  );
  const thread = rows[0];
  if (!thread) throw notFound("That thread");
  return thread;
}

const FLAG_ACTIONS = {
  lock: { column: "locked", value: true },
  unlock: { column: "locked", value: false },
  sticky: { column: "sticky", value: true },
  unsticky: { column: "sticky", value: false },
} as const;

export type ThreadFlagAction = keyof typeof FLAG_ACTIONS;

export function isThreadFlagAction(s: string): s is ThreadFlagAction {
  return Object.hasOwn(FLAG_ACTIONS, s);
}

export async function setThreadFlag(
  ctx: ForumContext,
  viewer: Viewer | null,
  threadId: number,
  action: ThreadFlagAction,
  rawReason: string
): Promise<void> {
  if (!asModerator(viewer)) throw notFound("That page");
  const reason = optionalReason(rawReason);
  const { column, value } = FLAG_ACTIONS[action];
  await withTransaction(ctx.pool, async (client) => {
    const thread = await lockThreadForMod(client, threadId);
    if (thread[column] === value) return; // Already so; nothing to log.
    await client.query(`UPDATE threads SET ${column} = $2 WHERE id = $1`, [threadId, value]);
    await logAction(client, viewer, action, "thread", threadId, reason);
  });
}

export async function moveThread(
  ctx: ForumContext,
  viewer: Viewer | null,
  threadId: number,
  toBoardSlug: string,
  rawReason: string
): Promise<void> {
  if (!asModerator(viewer)) throw notFound("That page");
  const reason = optionalReason(rawReason);
  await withTransaction(ctx.pool, async (client) => {
    const thread = await lockThreadForMod(client, threadId);
    const { rows } = await client.query<{ id: number; slug: string }>(
      "SELECT id, slug FROM boards WHERE slug = $1 AND deleted_at IS NULL",
      [toBoardSlug]
    );
    const to = rows[0];
    if (!to) throw invalid("That board doesn't exist.");
    if (to.id === thread.board_id) return;
    const { rows: from } = await client.query<{ slug: string }>("SELECT slug FROM boards WHERE id = $1", [
      thread.board_id,
    ]);
    const posts = thread.reply_count + 1;
    await client.query("UPDATE threads SET board_id = $2 WHERE id = $1", [threadId, to.id]);
    await client.query(
      "UPDATE boards SET thread_count = thread_count - 1, post_count = post_count - $2 WHERE id = $1",
      [thread.board_id, posts]
    );
    await client.query(
      "UPDATE boards SET thread_count = thread_count + 1, post_count = post_count + $2 WHERE id = $1",
      [to.id, posts]
    );
    await logAction(client, viewer, "move", "thread", threadId, reason, {
      from_board: from[0]!.slug,
      to_board: to.slug,
    });
  });
}

/**
 * Removes a post: it keeps its place in the thread as "[removed by
 * moderator]", with the reason visible to moderators. The author's post count
 * drops so removed posts don't count toward rank.
 */
export async function removePost(
  ctx: ForumContext,
  viewer: Viewer | null,
  postId: number,
  rawReason: string
): Promise<void> {
  if (!canRemovePost(viewer)) throw notFound("That page");
  const reason = validateReason(rawReason);
  await withTransaction(ctx.pool, async (client) => {
    const { rows } = await client.query<{ author_id: number }>(
      `UPDATE posts SET deleted_at = NOW(), deleted_by = $2, delete_reason = $3
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING author_id`,
      [postId, viewer.id, reason]
    );
    const post = rows[0];
    if (!post) throw invalid("That post is already removed, or doesn't exist.");
    await client.query("UPDATE users SET post_count = GREATEST(post_count - 1, 0) WHERE id = $1", [post.author_id]);
    await logAction(client, viewer, "remove_post", "post", postId, reason);
  });
}

export async function restorePost(
  ctx: ForumContext,
  viewer: Viewer | null,
  postId: number,
  rawReason: string
): Promise<void> {
  if (!canRestorePost(viewer)) throw notFound("That page");
  const reason = optionalReason(rawReason);
  await withTransaction(ctx.pool, async (client) => {
    const { rows } = await client.query<{ author_id: number }>(
      `UPDATE posts SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL
        WHERE id = $1 AND deleted_at IS NOT NULL
        RETURNING author_id`,
      [postId]
    );
    const post = rows[0];
    if (!post) throw invalid("That post isn't removed.");
    await client.query("UPDATE users SET post_count = post_count + 1 WHERE id = $1", [post.author_id]);
    await logAction(client, viewer, "restore_post", "post", postId, reason);
  });
}

async function findMember(client: PoolClient, username: string) {
  const { rows } = await client.query<{ id: number; username: string; role: string; status: UserStatus }>(
    "SELECT id, username, role, status FROM users WHERE LOWER(username) = LOWER($1) AND deleted_at IS NULL",
    [username.trim()]
  );
  const member = rows[0];
  if (!member) throw notFound("That member");
  return member;
}

export const WARNING_SUBJECT = "A note from the moderators";

/** A private warning: delivered by PM from the moderator, and logged publicly. */
export async function warnMember(
  ctx: ForumContext,
  viewer: Viewer | null,
  username: string,
  rawReason: string,
  message: string
): Promise<void> {
  if (!asModerator(viewer)) throw notFound("That page");
  const reason = validateReason(rawReason);
  await withTransaction(ctx.pool, async (client) => {
    const member = await findMember(client, username);
    if (member.id === viewer.id) throw invalid("You can't warn yourself.");
    const body = message.trim() === "" ? reason : message;
    await startConversationTx(ctx, client, viewer, member.username, WARNING_SUBJECT, body);
    await logAction(client, viewer, "warn", "user", member.id, reason);
  });
}

const STATUS_ACTIONS: Record<UserStatus, ModAction> = {
  active: "reinstate",
  suspended: "suspend",
  banned: "ban",
};

/** Suspend (can read, can't post), ban (can't log in), or reinstate. Admin only. */
export async function setMemberStatus(
  ctx: ForumContext,
  viewer: Viewer | null,
  username: string,
  status: UserStatus,
  rawReason: string
): Promise<void> {
  if (!canChangeMemberStatus(viewer)) throw notFound("That page");
  const reason = validateReason(rawReason);
  await withTransaction(ctx.pool, async (client) => {
    const member = await findMember(client, username);
    if (member.id === viewer.id) throw invalid("You can't change your own standing.");
    if (member.status === status) return;
    await client.query("UPDATE users SET status = $2 WHERE id = $1", [member.id, status]);
    if (status === "banned") await client.query("DELETE FROM sessions WHERE user_id = $1", [member.id]);
    await logAction(client, viewer, STATUS_ACTIONS[status], "user", member.id, reason);
  });
}

// ── Reports ────────────────────────────────────────────────────────────────

export async function reportPost(
  ctx: ForumContext,
  viewer: Viewer | null,
  postId: number,
  rawReason: string
): Promise<void> {
  if (!isMember(viewer)) throw forbidden("Only members can report posts.");
  const reason = validateReason(rawReason, "a reason for the report");
  const { rows } = await ctx.pool.query<{ members_only: boolean; deleted: boolean }>(
    `SELECT b.members_only, p.deleted_at IS NOT NULL AS deleted
       FROM posts p JOIN threads t ON t.id = p.thread_id JOIN boards b ON b.id = t.board_id
      WHERE p.id = $1 AND t.deleted_at IS NULL AND b.deleted_at IS NULL`,
    [postId]
  );
  const post = rows[0];
  if (!post || !canSeeBoard(viewer, { membersOnly: post.members_only })) throw notFound("That post");
  if (post.deleted) throw invalid("That post has already been removed.");
  await ctx.pool.query("INSERT INTO reports (post_id, reporter_id, reason) VALUES ($1, $2, $3)", [
    postId,
    viewer.id,
    reason,
  ]);
}

export interface OpenReport {
  id: number;
  postId: number;
  threadId: number;
  threadTitle: string;
  postAuthorName: string;
  postBodyHtml: string;
  postRemoved: boolean;
  reporterName: string;
  reason: string;
  createdAt: Date;
}

export async function listOpenReports(ctx: ForumContext, viewer: Viewer | null): Promise<OpenReport[]> {
  if (!asModerator(viewer)) throw notFound("That page");
  const { rows } = await ctx.pool.query<{
    id: number;
    post_id: number;
    thread_id: number;
    thread_title: string;
    post_author: string;
    body_html: string;
    removed: boolean;
    reporter: string;
    reason: string;
    created_at: Date;
  }>(
    `SELECT r.id, r.post_id, p.thread_id, t.title AS thread_title, pa.username AS post_author,
            p.body_html, p.deleted_at IS NOT NULL AS removed, ru.username AS reporter,
            r.reason, r.created_at
       FROM reports r
       JOIN posts p ON p.id = r.post_id
       JOIN threads t ON t.id = p.thread_id
       JOIN users pa ON pa.id = p.author_id
       JOIN users ru ON ru.id = r.reporter_id
      WHERE r.resolved_at IS NULL
      ORDER BY r.created_at`
  );
  return rows.map((r) => ({
    id: r.id,
    postId: r.post_id,
    threadId: r.thread_id,
    threadTitle: r.thread_title,
    postAuthorName: r.post_author,
    postBodyHtml: r.body_html,
    postRemoved: r.removed,
    reporterName: r.reporter,
    reason: r.reason,
    createdAt: r.created_at,
  }));
}

export async function openReportCount(ctx: ForumContext): Promise<number> {
  const { rows } = await ctx.pool.query<{ n: number }>("SELECT COUNT(*) AS n FROM reports WHERE resolved_at IS NULL");
  return rows[0]!.n;
}

export async function resolveReport(
  ctx: ForumContext,
  viewer: Viewer | null,
  reportId: number,
  rawResolution: string
): Promise<void> {
  if (!asModerator(viewer)) throw notFound("That page");
  const resolution = optionalReason(rawResolution);
  await withTransaction(ctx.pool, async (client) => {
    const { rows } = await client.query(
      `UPDATE reports SET resolved_at = NOW(), resolved_by = $2, resolution = $3
        WHERE id = $1 AND resolved_at IS NULL RETURNING id`,
      [reportId, viewer.id, resolution]
    );
    if (rows.length === 0) throw invalid("That report is already resolved.");
    await logAction(client, viewer, "resolve_report", "report", reportId, resolution);
  });
}

// ── The public mod log ─────────────────────────────────────────────────────

export interface ModLogEntry {
  id: number;
  at: Date;
  moderatorName: string;
  action: ModAction;
  reason: string;
  /** What was acted on, as the viewer may see it. */
  target: { label: string; path: string | null };
  details: { fromBoard?: string; toBoard?: string };
}

const REDACTED = "something in a members-only board";

/**
 * Every moderation action, newest first. Targets in the members-only board
 * are redacted for anyone who can't see that board, reason included, so the
 * public log can't leak what the Back Room is talking about.
 */
export async function listModLog(
  ctx: ForumContext,
  viewer: Viewer | null,
  rawPage: string | undefined
): Promise<{ entries: ModLogEntry[]; page: Page }> {
  const { rows: count } = await ctx.pool.query<{ n: number }>("SELECT COUNT(*) AS n FROM mod_actions");
  const page = paginate(rawPage, count[0]!.n, config.pagination.mod_log_per_page);
  const { rows } = await ctx.pool.query<{
    id: number;
    created_at: Date;
    moderator: string;
    action: ModAction;
    target_type: TargetType;
    target_id: number;
    reason: string;
    details: { from_board?: string; to_board?: string };
    thread_id: number | null;
    thread_title: string | null;
    private_target: boolean;
    username: string | null;
    from_private: boolean;
    to_private: boolean;
  }>(
    `SELECT a.id, a.created_at, m.username AS moderator, a.action, a.target_type, a.target_id,
            a.reason, a.details,
            COALESCE(t.id, pt.id) AS thread_id,
            COALESCE(t.title, pt.title) AS thread_title,
            COALESCE(b.members_only, pb.members_only, FALSE) AS private_target,
            u.username,
            COALESCE(fb.members_only, FALSE) AS from_private,
            COALESCE(tb.members_only, FALSE) AS to_private
       FROM mod_actions a
       JOIN users m ON m.id = a.moderator_id
       LEFT JOIN threads t ON a.target_type = 'thread' AND t.id = a.target_id
       LEFT JOIN boards b ON b.id = t.board_id
       LEFT JOIN reports r ON a.target_type = 'report' AND r.id = a.target_id
       LEFT JOIN posts p ON p.id = CASE a.target_type WHEN 'post' THEN a.target_id WHEN 'report' THEN r.post_id END
       LEFT JOIN threads pt ON pt.id = p.thread_id
       LEFT JOIN boards pb ON pb.id = pt.board_id
       LEFT JOIN users u ON a.target_type = 'user' AND u.id = a.target_id
       LEFT JOIN boards fb ON fb.slug = a.details->>'from_board'
       LEFT JOIN boards tb ON tb.slug = a.details->>'to_board'
      ORDER BY a.id DESC
      LIMIT $1 OFFSET $2`,
    [page.perPage, page.offset]
  );

  const canSeePrivate = isMember(viewer);
  return {
    page,
    entries: rows.map((r) => {
      const hidden = !canSeePrivate && (r.private_target || r.from_private || r.to_private);
      let target: ModLogEntry["target"];
      if (hidden) {
        target = { label: REDACTED, path: null };
      } else if (r.target_type === "user") {
        target = { label: r.username ?? "a former member", path: r.username ? `/u/${encodeURIComponent(r.username)}` : null };
      } else if (r.target_type === "thread") {
        target = { label: r.thread_title ?? "a thread", path: r.thread_id ? `/t/${r.thread_id}` : null };
      } else {
        const what = r.target_type === "report" ? "a report on a post" : "a post";
        target = { label: r.thread_title ? `${what} in “${r.thread_title}”` : what, path: r.target_type === "post" ? `/p/${r.target_id}` : null };
      }
      return {
        id: r.id,
        at: r.created_at,
        moderatorName: r.moderator,
        action: r.action,
        reason: hidden ? "" : r.reason,
        target,
        details: hidden ? {} : { fromBoard: r.details.from_board, toBoard: r.details.to_board },
      };
    }),
  };
}
