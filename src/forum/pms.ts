import type { PoolClient } from "pg";
import { config } from "../config.js";
import { withTransaction } from "../db/index.js";
import { MARKUP_VERSION } from "../markup/bbcode.js";
import { paginate, type Page } from "../lib/pagination.js";
import { authorColumns, toAuthor, type AuthorRow } from "./authors.js";
import type { ForumContext } from "./context.js";
import { forbidden, invalid, notFound } from "./errors.js";
import { asAdmin, canPost, canReadConversation } from "./permissions.js";
import type { Author, Viewer } from "./types.js";
import { validatePmSubject, validatePostBody } from "./validate.js";

/**
 * Private messages. v1 conversations are one-to-one, but everything goes
 * through pm_participants so group PMs need no schema change. The admin can
 * read every conversation (the site rules say so); reading as admin never
 * marks anything read for the participants.
 */

async function insertMessage(
  ctx: ForumContext,
  client: PoolClient,
  conversationId: number,
  authorId: number,
  body: string
): Promise<number> {
  const { rows } = await client.query<{ id: number; created_at: Date }>(
    `INSERT INTO pm_messages (conversation_id, author_id, body, body_html, markup_version)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
    [conversationId, authorId, body, ctx.renderMarkup(body), MARKUP_VERSION]
  );
  const msg = rows[0]!;
  await client.query("UPDATE pm_conversations SET last_message_at = $2 WHERE id = $1", [
    conversationId,
    msg.created_at,
  ]);
  // The sender has read their own message; the conversation reappears in
  // any inbox that had archived it.
  await client.query(
    `UPDATE pm_participants
        SET last_read_message_id = CASE WHEN user_id = $2 THEN $3 ELSE last_read_message_id END,
            deleted_at = NULL
      WHERE conversation_id = $1`,
    [conversationId, authorId, msg.id]
  );
  return msg.id;
}

/**
 * Starts a conversation inside the caller's transaction. Moderation uses this
 * to deliver warnings atomically with the mod-log entry.
 */
export async function startConversationTx(
  ctx: ForumContext,
  client: PoolClient,
  sender: Viewer,
  toUsername: string,
  rawSubject: string,
  rawBody: string
): Promise<number> {
  const subject = validatePmSubject(rawSubject);
  const body = validatePostBody(rawBody);
  const { rows: to } = await client.query<{ id: number }>(
    "SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND deleted_at IS NULL",
    [toUsername.trim()]
  );
  const recipient = to[0];
  if (!recipient) throw invalid(`There's no member called “${toUsername.trim()}”.`);
  if (recipient.id === sender.id) throw invalid("You can't send a message to yourself.");

  const { rows } = await client.query<{ id: number }>(
    "INSERT INTO pm_conversations (subject) VALUES ($1) RETURNING id",
    [subject]
  );
  const conversationId = rows[0]!.id;
  await client.query(
    "INSERT INTO pm_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)",
    [conversationId, sender.id, recipient.id]
  );
  await insertMessage(ctx, client, conversationId, sender.id, body);
  return conversationId;
}

export async function sendNewMessage(
  ctx: ForumContext,
  viewer: Viewer | null,
  toUsername: string,
  subject: string,
  body: string
): Promise<number> {
  if (!canPost(viewer)) throw forbidden("Only members can send messages.");
  return withTransaction(ctx.pool, (client) =>
    startConversationTx(ctx, client, viewer, toUsername, subject, body)
  );
}

export async function replyToConversation(
  ctx: ForumContext,
  viewer: Viewer | null,
  conversationId: number,
  rawBody: string
): Promise<number> {
  if (!canPost(viewer)) throw forbidden("Only members can send messages.");
  const body = validatePostBody(rawBody);
  return withTransaction(ctx.pool, async (client) => {
    const { rows } = await client.query(
      `SELECT 1 FROM pm_participants WHERE conversation_id = $1 AND user_id = $2 FOR UPDATE`,
      [conversationId, viewer.id]
    );
    // Only participants reply; the admin reads but doesn't join in.
    if (rows.length === 0) throw notFound("That conversation");
    return insertMessage(ctx, client, conversationId, viewer.id, body);
  });
}

export interface InboxItem {
  id: number;
  subject: string;
  /** Everyone in the conversation except the viewer (or all of them, in the admin's list). */
  with: string[];
  lastMessageAt: Date;
  unread: boolean;
}

interface InboxRow {
  id: number;
  subject: string;
  names: string[];
  last_message_at: Date;
  unread: boolean;
}

const toInboxItem = (r: InboxRow): InboxItem => ({
  id: r.id,
  subject: r.subject,
  with: r.names,
  lastMessageAt: r.last_message_at,
  unread: r.unread,
});

const UNREAD_SQL = `EXISTS (
  SELECT 1 FROM pm_messages m
   WHERE m.conversation_id = pp.conversation_id AND m.author_id <> pp.user_id
     AND m.deleted_at IS NULL AND m.id > COALESCE(pp.last_read_message_id, 0))`;

export async function listInbox(
  ctx: ForumContext,
  viewer: Viewer | null,
  rawPage: string | undefined
): Promise<{ items: InboxItem[]; page: Page }> {
  if (viewer === null) throw forbidden();
  const { rows: count } = await ctx.pool.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM pm_participants WHERE user_id = $1 AND deleted_at IS NULL",
    [viewer.id]
  );
  const page = paginate(rawPage, count[0]!.n, config.pagination.inbox_per_page);
  const { rows } = await ctx.pool.query<InboxRow>(
    `SELECT c.id, c.subject, c.last_message_at, ${UNREAD_SQL} AS unread,
            ARRAY(SELECT u.username FROM pm_participants o JOIN users u ON u.id = o.user_id
                   WHERE o.conversation_id = c.id AND o.user_id <> pp.user_id
                   ORDER BY LOWER(u.username)) AS names
       FROM pm_participants pp
       JOIN pm_conversations c ON c.id = pp.conversation_id
      WHERE pp.user_id = $1 AND pp.deleted_at IS NULL
      ORDER BY c.last_message_at DESC, c.id DESC
      LIMIT $2 OFFSET $3`,
    [viewer.id, page.perPage, page.offset]
  );
  return { page, items: rows.map(toInboxItem) };
}

/** Every conversation on the board, for the admin. */
export async function listAllConversations(
  ctx: ForumContext,
  viewer: Viewer | null,
  rawPage: string | undefined
): Promise<{ items: InboxItem[]; page: Page }> {
  if (!asAdmin(viewer)) throw notFound("That page");
  const { rows: count } = await ctx.pool.query<{ n: number }>("SELECT COUNT(*) AS n FROM pm_conversations");
  const page = paginate(rawPage, count[0]!.n, config.pagination.inbox_per_page);
  const { rows } = await ctx.pool.query<InboxRow>(
    `SELECT c.id, c.subject, c.last_message_at, FALSE AS unread,
            ARRAY(SELECT u.username FROM pm_participants o JOIN users u ON u.id = o.user_id
                   WHERE o.conversation_id = c.id ORDER BY LOWER(u.username)) AS names
       FROM pm_conversations c
      ORDER BY c.last_message_at DESC, c.id DESC
      LIMIT $1 OFFSET $2`,
    [page.perPage, page.offset]
  );
  return { page, items: rows.map(toInboxItem) };
}

/** How many conversations have something the member hasn't read. */
export async function unreadConversationCount(ctx: ForumContext, viewer: Viewer): Promise<number> {
  const { rows } = await ctx.pool.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM pm_participants pp
      WHERE pp.user_id = $1 AND pp.deleted_at IS NULL AND ${UNREAD_SQL}`,
    [viewer.id]
  );
  return rows[0]!.n;
}

export interface PmMessage {
  id: number;
  author: Author;
  bodyHtml: string;
  createdAt: Date;
}

export interface Conversation {
  id: number;
  subject: string;
  participants: { id: number; username: string }[];
  /** True when the admin is reading a conversation they aren't part of. */
  readingAsAdmin: boolean;
  isParticipant: boolean;
  messages: PmMessage[];
  page: Page;
}

/** Reads a conversation. Defaults to its last page, where the new messages are. */
export async function readConversation(
  ctx: ForumContext,
  viewer: Viewer | null,
  conversationId: number,
  rawPage: string | undefined
): Promise<Conversation> {
  const { rows: convRows } = await ctx.pool.query<{ subject: string }>(
    "SELECT subject FROM pm_conversations WHERE id = $1",
    [conversationId]
  );
  const conv = convRows[0];
  const { rows: people } = await ctx.pool.query<{ id: number; username: string }>(
    `SELECT u.id, u.username FROM pm_participants p JOIN users u ON u.id = p.user_id
      WHERE p.conversation_id = $1 ORDER BY LOWER(u.username)`,
    [conversationId]
  );
  const ids = people.map((p) => p.id);
  // Not yours and you're not the admin: it doesn't exist.
  if (!conv || !canReadConversation(viewer, ids)) throw notFound("That conversation");
  const isParticipant = ids.includes(viewer.id);

  const { rows: count } = await ctx.pool.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM pm_messages WHERE conversation_id = $1 AND deleted_at IS NULL",
    [conversationId]
  );
  const perPage = config.pagination.posts_per_page;
  const total = count[0]!.n;
  const page = paginate(rawPage ?? Math.max(1, Math.ceil(total / perPage)), total, perPage);
  const { rows } = await ctx.pool.query<AuthorRow & { id: number; body_html: string; created_at: Date }>(
    `SELECT m.id, m.body_html, m.created_at, ${authorColumns("a")}
       FROM pm_messages m JOIN users a ON a.id = m.author_id
      WHERE m.conversation_id = $1 AND m.deleted_at IS NULL
      ORDER BY m.id
      LIMIT $2 OFFSET $3`,
    [conversationId, page.perPage, page.offset]
  );

  const lastShown = rows[rows.length - 1]?.id;
  if (isParticipant && lastShown !== undefined) {
    await ctx.pool.query(
      `UPDATE pm_participants
          SET last_read_message_id = GREATEST(COALESCE(last_read_message_id, 0), $3)
        WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, viewer.id, lastShown]
    );
  }

  return {
    id: conversationId,
    subject: conv.subject,
    participants: people,
    readingAsAdmin: !isParticipant,
    isParticipant,
    page,
    messages: rows.map((r) => ({ id: r.id, author: toAuthor(r), bodyHtml: r.body_html, createdAt: r.created_at })),
  };
}
