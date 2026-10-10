import type { ForumContext } from "./context.js";
import { notFound } from "./errors.js";
import { asAdmin, visibleBoardsSql } from "./permissions.js";
import { getThread } from "./threads.js";
import type { Role, UserStatus, Viewer } from "./types.js";

/**
 * The admin's downloads (/admin/export): a thread, the whole archive, or one
 * member's activity, as data for src/export/markdown.ts to write out. Admin
 * only, so everything is included as the admin sees it on the board: removed
 * posts keep their text and reason, the Back Room and PMs are there unless
 * the options leave them out. Anyone else gets a 404, as with all of /admin.
 */

export interface ExportOptions {
  /** Only what was written from this moment on; null for everything. */
  since: Date | null;
  /** Include members-only boards (the Back Room). */
  backRoom: boolean;
  /** Include private messages (the archive only; a member's file always has them). */
  pms: boolean;
}

export interface ExportPost {
  id: number;
  /** 1-based position in its thread, counting every post. */
  number: number;
  authorName: string;
  authorIsBot: boolean;
  /** The markup as written, removed posts included. */
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  editedByName: string | null;
  removed: { at: Date; byName: string | null; reason: string | null } | null;
}

export interface ExportThread {
  id: number;
  title: string;
  boardName: string;
  boardSlug: string;
  membersOnly: boolean;
  authorName: string;
  createdAt: Date;
  sticky: boolean;
  locked: boolean;
  isRules: boolean;
  fpArticleId: number | null;
  /** Every post in the thread, before the since date too. */
  totalPosts: number;
  posts: ExportPost[];
}

export interface ExportModAction {
  at: Date;
  moderatorName: string;
  action: string;
  /** What was acted on, as words: `post 12 in "Bridges"`, `member Dan`. */
  target: string;
  reason: string;
  fromBoard: string | null;
  toBoard: string | null;
}

export interface ExportReport {
  at: Date;
  reporterName: string;
  target: string;
  reason: string;
  resolvedAt: Date | null;
  resolvedByName: string | null;
  resolution: string | null;
}

export interface ExportMessage {
  authorName: string;
  authorIsBot: boolean;
  body: string;
  createdAt: Date;
}

export interface ExportConversation {
  id: number;
  subject: string;
  participants: { username: string; isBot: boolean }[];
  /** Every message, before the since date too. */
  totalMessages: number;
  messages: ExportMessage[];
}

export interface ExportMember {
  id: number;
  username: string;
  isBot: boolean;
  role: Role;
  status: UserStatus;
  title: string | null;
  bio: string;
  postCount: number;
  joinedAt: Date;
}

export interface ExportBoard {
  slug: string;
  name: string;
  category: string;
  description: string;
  membersOnly: boolean;
  threadCount: number;
  postCount: number;
}

export interface ThreadExport {
  options: ExportOptions;
  thread: ExportThread;
  modActions: ExportModAction[];
}

export interface ArchiveExport {
  options: ExportOptions;
  boards: ExportBoard[];
  members: ExportMember[];
  threads: ExportThread[];
  /** Null when PMs were left out. */
  conversations: ExportConversation[] | null;
  modActions: ExportModAction[];
  reports: ExportReport[];
}

export interface MemberExport {
  options: ExportOptions;
  member: ExportMember;
  posts: (ExportPost & { threadId: number; threadTitle: string; boardName: string })[];
  conversations: ExportConversation[];
  /** Moderation the member did, and moderation of the member and their posts. */
  modActionsBy: ExportModAction[];
  modActionsOn: ExportModAction[];
}

function admin(viewer: Viewer | null): Viewer {
  if (!asAdmin(viewer)) throw notFound();
  return viewer;
}

/** The boards an export reads from: what the admin sees, less the Back Room if left out. */
function boardsSql(viewer: Viewer, opts: ExportOptions, alias = "b"): string {
  return `${visibleBoardsSql(viewer, alias)}${opts.backRoom ? "" : ` AND NOT ${alias}.members_only`}`;
}

// ── Posts and threads ──────────────────────────────────────────────────────

interface PostRow {
  id: number;
  thread_id: number;
  number: string;
  body: string;
  created_at: Date;
  edited_at: Date | null;
  edited_by_name: string | null;
  deleted_at: Date | null;
  deleted_by_name: string | null;
  delete_reason: string | null;
  author_name: string;
  author_is_bot: boolean;
}

const toPost = (r: PostRow): ExportPost => ({
  id: r.id,
  number: Number(r.number),
  authorName: r.author_name,
  authorIsBot: r.author_is_bot,
  body: r.body,
  createdAt: r.created_at,
  editedAt: r.edited_at,
  editedByName: r.edited_by_name,
  removed: r.deleted_at ? { at: r.deleted_at, byName: r.deleted_by_name, reason: r.delete_reason } : null,
});

/**
 * Posts in threads matching `threadWhere` (over threads t and boards b),
 * numbered by their place in the whole thread, then cut to the since date
 * and `postWhere` (over the numbered rows x). Oldest first.
 */
async function selectPosts(
  ctx: ForumContext,
  threadWhere: string,
  postWhere: string,
  params: unknown[],
  since: Date | null
): Promise<PostRow[]> {
  const sinceParam = params.length + 1;
  const { rows } = await ctx.pool.query<PostRow>(
    `SELECT * FROM (
       SELECT p.id, p.thread_id, p.author_id, ROW_NUMBER() OVER (PARTITION BY p.thread_id ORDER BY p.id) AS number,
              p.body, p.created_at, p.edited_at, p.deleted_at, p.delete_reason,
              a.username AS author_name, a.is_bot AS author_is_bot,
              eu.username AS edited_by_name, du.username AS deleted_by_name
         FROM posts p
         JOIN threads t ON t.id = p.thread_id
         JOIN boards b ON b.id = t.board_id
         JOIN users a ON a.id = p.author_id
         LEFT JOIN users eu ON eu.id = p.edited_by
         LEFT JOIN users du ON du.id = p.deleted_by
        WHERE t.deleted_at IS NULL AND ${threadWhere}) x
      WHERE ($${sinceParam}::timestamptz IS NULL OR x.created_at >= $${sinceParam}) AND ${postWhere}
      ORDER BY x.thread_id, x.id`,
    [...params, since]
  );
  return rows;
}

interface ThreadRow {
  id: number;
  title: string;
  board_name: string;
  board_slug: string;
  members_only: boolean;
  author_name: string;
  created_at: Date;
  sticky: boolean;
  locked: boolean;
  is_rules: boolean;
  fp_article_id: number | null;
  total_posts: number;
}

async function selectThreads(ctx: ForumContext, ids: number[]): Promise<ThreadRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await ctx.pool.query<ThreadRow>(
    `SELECT t.id, t.title, b.name AS board_name, b.slug AS board_slug, b.members_only, a.username AS author_name,
            t.created_at, t.sticky, t.locked, t.is_rules, t.fp_article_id, t.reply_count + 1 AS total_posts
       FROM threads t
       JOIN boards b ON b.id = t.board_id
       JOIN users a ON a.id = t.author_id
      WHERE t.id = ANY($1::bigint[])
      ORDER BY t.created_at, t.id`,
    [ids]
  );
  return rows;
}

function toThread(t: ThreadRow, posts: ExportPost[]): ExportThread {
  return {
    id: t.id,
    title: t.title,
    boardName: t.board_name,
    boardSlug: t.board_slug,
    membersOnly: t.members_only,
    authorName: t.author_name,
    createdAt: t.created_at,
    sticky: t.sticky,
    locked: t.locked,
    isRules: t.is_rules,
    fpArticleId: t.fp_article_id,
    totalPosts: t.total_posts,
    posts,
  };
}

/** Threads with posts, each with its posts, oldest thread first. */
async function threadsOf(ctx: ForumContext, rows: PostRow[]): Promise<ExportThread[]> {
  const byThread = new Map<number, ExportPost[]>();
  for (const r of rows) {
    const list = byThread.get(r.thread_id) ?? [];
    list.push(toPost(r));
    byThread.set(r.thread_id, list);
  }
  const threads = await selectThreads(ctx, [...byThread.keys()]);
  return threads.map((t) => toThread(t, byThread.get(t.id)!));
}

// ── Moderation ─────────────────────────────────────────────────────────────

/**
 * Mod actions matching `where` (over mod_actions a, the post p it touches,
 * directly or through a report, and the member u it targets), oldest first.
 * Actions on the Back Room are left out unless the options include it.
 */
async function selectModActions(
  ctx: ForumContext,
  opts: ExportOptions,
  where: string,
  params: unknown[]
): Promise<ExportModAction[]> {
  const sinceParam = params.length + 1;
  const { rows } = await ctx.pool.query<{
    created_at: Date;
    moderator: string;
    action: string;
    target_type: string;
    target_id: number;
    reason: string;
    details: { from_board?: string; to_board?: string };
    thread_title: string | null;
    post_id: number | null;
    username: string | null;
    private_target: boolean;
  }>(
    `SELECT a.created_at, m.username AS moderator, a.action, a.target_type, a.target_id, a.reason, a.details,
            COALESCE(t.title, pt.title) AS thread_title, p.id AS post_id, u.username,
            COALESCE(b.members_only, pb.members_only, FALSE) OR COALESCE(fb.members_only, FALSE)
              OR COALESCE(tb.members_only, FALSE) AS private_target
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
      WHERE ($${sinceParam}::timestamptz IS NULL OR a.created_at >= $${sinceParam}) AND (${where})
      ORDER BY a.id`,
    [...params, opts.since]
  );
  return rows
    .filter((r) => opts.backRoom || !r.private_target)
    .map((r) => {
      const inThread = r.thread_title ? ` in "${r.thread_title}"` : "";
      let target: string;
      if (r.target_type === "user") target = `member ${r.username ?? `#${r.target_id}`}`;
      else if (r.target_type === "thread") target = `thread "${r.thread_title ?? `#${r.target_id}`}"`;
      else if (r.target_type === "report") target = `a report on post ${r.post_id ?? "?"}${inThread}`;
      else target = `post ${r.target_id}${inThread}`;
      return {
        at: r.created_at,
        moderatorName: r.moderator,
        action: r.action,
        target,
        reason: r.reason,
        fromBoard: r.details.from_board ?? null,
        toBoard: r.details.to_board ?? null,
      };
    });
}

async function selectReports(ctx: ForumContext, viewer: Viewer, opts: ExportOptions): Promise<ExportReport[]> {
  const { rows } = await ctx.pool.query<{
    created_at: Date;
    reporter: string;
    post_id: number;
    thread_title: string;
    reason: string;
    resolved_at: Date | null;
    resolver: string | null;
    resolution: string | null;
  }>(
    `SELECT r.created_at, ru.username AS reporter, r.post_id, t.title AS thread_title, r.reason,
            r.resolved_at, vu.username AS resolver, r.resolution
       FROM reports r
       JOIN users ru ON ru.id = r.reporter_id
       LEFT JOIN users vu ON vu.id = r.resolved_by
       JOIN posts p ON p.id = r.post_id
       JOIN threads t ON t.id = p.thread_id
       JOIN boards b ON b.id = t.board_id
      WHERE ${boardsSql(viewer, opts)} AND ($1::timestamptz IS NULL OR r.created_at >= $1)
      ORDER BY r.id`,
    [opts.since]
  );
  return rows.map((r) => ({
    at: r.created_at,
    reporterName: r.reporter,
    target: `post ${r.post_id} in "${r.thread_title}"`,
    reason: r.reason,
    resolvedAt: r.resolved_at,
    resolvedByName: r.resolver,
    resolution: r.resolution,
  }));
}

// ── Private messages ───────────────────────────────────────────────────────

/** Conversations matching `where` (over pm_conversations c), with their messages since the date. */
async function selectConversations(ctx: ForumContext, since: Date | null, where: string, params: unknown[]): Promise<ExportConversation[]> {
  const sinceParam = params.length + 1;
  const { rows } = await ctx.pool.query<{
    conversation_id: number;
    subject: string;
    total: number;
    author_name: string;
    author_is_bot: boolean;
    body: string;
    created_at: Date;
  }>(
    `SELECT c.id AS conversation_id, c.subject,
            (SELECT COUNT(*)::int FROM pm_messages t WHERE t.conversation_id = c.id AND t.deleted_at IS NULL) AS total,
            a.username AS author_name, a.is_bot AS author_is_bot, m.body, m.created_at
       FROM pm_conversations c
       JOIN pm_messages m ON m.conversation_id = c.id
       JOIN users a ON a.id = m.author_id
      WHERE m.deleted_at IS NULL AND ($${sinceParam}::timestamptz IS NULL OR m.created_at >= $${sinceParam}) AND (${where})
      ORDER BY c.id, m.id`,
    [...params, since]
  );
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.map((r) => r.conversation_id))];
  const { rows: people } = await ctx.pool.query<{ conversation_id: number; username: string; is_bot: boolean }>(
    `SELECT p.conversation_id, u.username, u.is_bot FROM pm_participants p JOIN users u ON u.id = p.user_id
      WHERE p.conversation_id = ANY($1::bigint[]) ORDER BY LOWER(u.username)`,
    [ids]
  );
  const byId = new Map<number, ExportConversation>();
  for (const r of rows) {
    let conv = byId.get(r.conversation_id);
    if (!conv) {
      conv = {
        id: r.conversation_id,
        subject: r.subject,
        participants: people.filter((p) => p.conversation_id === r.conversation_id).map((p) => ({ username: p.username, isBot: p.is_bot })),
        totalMessages: r.total,
        messages: [],
      };
      byId.set(r.conversation_id, conv);
    }
    conv.messages.push({ authorName: r.author_name, authorIsBot: r.author_is_bot, body: r.body, createdAt: r.created_at });
  }
  // Oldest conversation first, by its first message in the export.
  return [...byId.values()].sort((a, b) => a.messages[0]!.createdAt.getTime() - b.messages[0]!.createdAt.getTime());
}

// ── Members ────────────────────────────────────────────────────────────────

const MEMBER_SELECT = `SELECT id, username, is_bot, role, status, title, bio, post_count, joined_at FROM users`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toMember = (r: any): ExportMember => ({
  id: r.id,
  username: r.username,
  isBot: r.is_bot,
  role: r.role,
  status: r.status,
  title: r.title,
  bio: r.bio,
  postCount: r.post_count,
  joinedAt: r.joined_at,
});

// ── The three exports ──────────────────────────────────────────────────────

/** One thread, every post or those since the date, with its moderation. */
export async function exportThread(ctx: ForumContext, viewer: Viewer | null, threadId: number, opts: ExportOptions): Promise<ThreadExport> {
  const v = admin(viewer);
  await getThread(ctx, v, threadId);
  const rows = await selectPosts(ctx, `t.id = $1 AND ${visibleBoardsSql(v)}`, "TRUE", [threadId], opts.since);
  const [t] = await selectThreads(ctx, [threadId]);
  // The thread's own options: whatever board it's in, it was asked for by name.
  const own: ExportOptions = { ...opts, backRoom: true, pms: false };
  const modActions = await selectModActions(ctx, own, "t.id = $1 OR p.thread_id = $1", [threadId]);
  return { options: own, thread: toThread(t!, rows.map(toPost)), modActions };
}

/** Everything on the board: boards, members, threads, and as asked, PMs and the Back Room. */
export async function exportArchive(ctx: ForumContext, viewer: Viewer | null, opts: ExportOptions): Promise<ArchiveExport> {
  const v = admin(viewer);
  const { rows: boards } = await ctx.pool.query<{
    slug: string;
    name: string;
    category: string;
    description: string;
    members_only: boolean;
    thread_count: number;
    post_count: number;
  }>(
    `SELECT b.slug, b.name, c.name AS category, b.description, b.members_only, b.thread_count, b.post_count
       FROM boards b JOIN categories c ON c.id = b.category_id
      WHERE ${boardsSql(v, opts)} AND c.deleted_at IS NULL
      ORDER BY c.sort_order, c.id, b.sort_order, b.id`
  );
  const { rows: members } = await ctx.pool.query(`${MEMBER_SELECT} WHERE deleted_at IS NULL ORDER BY joined_at, id`);
  const threads = await threadsOf(ctx, await selectPosts(ctx, boardsSql(v, opts), "TRUE", [], opts.since));
  const conversations = opts.pms ? await selectConversations(ctx, opts.since, "TRUE", []) : null;
  return {
    options: opts,
    boards: boards.map((b) => ({
      slug: b.slug,
      name: b.name,
      category: b.category,
      description: b.description,
      membersOnly: b.members_only,
      threadCount: b.thread_count,
      postCount: b.post_count,
    })),
    members: members.map(toMember),
    threads,
    conversations,
    modActions: await selectModActions(ctx, opts, "TRUE", []),
    reports: await selectReports(ctx, v, opts),
  };
}

/**
 * One member's activity: their posts (each with its thread's title), every
 * conversation they're in, and the moderation they did and had done to them.
 * The bot file (src/botadmin/export.ts) is built on this.
 */
export async function exportMember(ctx: ForumContext, viewer: Viewer | null, userId: number, opts: ExportOptions): Promise<MemberExport> {
  const v = admin(viewer);
  const { rows } = await ctx.pool.query(`${MEMBER_SELECT} WHERE id = $1 AND deleted_at IS NULL`, [userId]);
  if (!rows[0]) throw notFound();
  const posts = await selectPosts(ctx, boardsSql(v, opts), "x.author_id = $1", [userId], opts.since);
  const threads = new Map((await selectThreads(ctx, [...new Set(posts.map((p) => p.thread_id))])).map((t) => [t.id, t]));
  const conversations = await selectConversations(
    ctx,
    opts.since,
    "EXISTS (SELECT 1 FROM pm_participants pp WHERE pp.conversation_id = c.id AND pp.user_id = $1)",
    [userId]
  );
  return {
    options: opts,
    member: toMember(rows[0]),
    posts: posts
      .map((r) => {
        const t = threads.get(r.thread_id)!;
        return { ...toPost(r), threadId: r.thread_id, threadTitle: t.title, boardName: t.board_name };
      })
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id),
    conversations,
    modActionsBy: await selectModActions(ctx, opts, "a.moderator_id = $1", [userId]),
    modActionsOn: await selectModActions(ctx, opts, "a.moderator_id <> $1 AND (u.id = $1 OR p.author_id = $1)", [userId]),
  };
}
