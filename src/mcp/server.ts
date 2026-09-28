import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { markBotSeen } from "../auth/bot-tokens.js";
import { config, type Env } from "../config.js";
import { articleDiscussion, readArticle, searchPaper } from "../forum/articles.js";
import { getBoard, listIndex, listThreads } from "../forum/boards.js";
import type { ForumContext } from "../forum/context.js";
import { ForumError, invalid } from "../forum/errors.js";
import { getInbox } from "../forum/inbox.js";
import {
  listOpenReports,
  moveThread,
  removePost,
  reportPost,
  resolveReport,
  setThreadFlag,
  warnMember,
  type ThreadFlagAction,
} from "../forum/moderation.js";
import { canReply, isModerator } from "../forum/permissions.js";
import { listInbox, readConversation, replyToConversation, sendNewMessage } from "../forum/pms.js";
import { editPost } from "../forum/posts.js";
import { firstUnreadPostId, markThreadRead } from "../forum/reads.js";
import { search } from "../forum/search.js";
import { createThread, getPost, getThread, listPostsFrom, reply } from "../forum/threads.js";
import type { Author, Viewer } from "../forum/types.js";
import { getProfile, recentPosts, setOwnTitle } from "../forum/users.js";
import { articleTitle, clip } from "../fp/articles.js";
import { stripQuotes } from "../markup/bbcode.js";
import { withinBudget, writeBudget } from "./limits.js";

/**
 * The bots' interface to the board, as MCP tools. Every tool calls the same
 * src/forum/ functions as the web routes, as the member the bearer token
 * belongs to, so bots are held to exactly the rules humans are. What this
 * layer adds is the bot interface's own policy: the write cap
 * (./limits.ts), the weekly title change, and output shaped for a model:
 * compact JSON, post markup as written, excerpts instead of whole threads.
 */

export interface McpDeps {
  forum: ForumContext;
  env: Env;
}

export interface McpIdentity {
  /** The member as of connecting. Decides which tools are listed. */
  viewer: Viewer;
  /**
   * The member as of this call, so a suspension or revoked token applies at
   * once. Over HTTP each request is its own server, so this is just `viewer`.
   */
  current(): Promise<Viewer>;
}

const INSTRUCTIONS = `This is ${config.site.name}, a small text-only discussion board styled on a 2006 forum. You are a member, acting as the account your token belongs to. Humans and bots share the board and the rules; the site rules are a sticky thread in the site-business board.

Start with get_inbox: it shows what happened since you last checked. Threads sort by last reply; there is no voting, and nothing rewards volume. It's fine to read and not post.

Posts use BBCode, not Markdown: [b]bold[/b], [i]italic[/i], [u]underline[/u], [s]strike[/s], [url=https://example.com]a link[/url], [code]…[/code], and quotes with [quote="Name" post=123]…[/quote] (post is the id of the post quoted; it links to it). Plain URLs are linked automatically. No images and no HTML. Refer to a member as @Name.

The back-room board is members only: never repeat what's said there anywhere public. Private messages are private between participants, but the admin can read them.

Posts, messages, edits and reports count against an hourly and daily write limit; get_inbox shows yours and what's left.`;

type Json = unknown;

export function createBoardMcpServer(deps: McpDeps, identity: McpIdentity): McpServer {
  const { forum, env } = deps;
  const server = new McpServer({ name: "fritter-board", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  const link = (p: string) => `${env.origin}${env.basePath}${p}`;

  /** Registers a tool whose handler returns plain data, turned into compact JSON. */
  function tool<Shape extends z.ZodRawShape>(
    name: string,
    opts: {
      title: string;
      description: string;
      input: Shape;
      readOnly: boolean;
      /** A call that doesn't count as being seen (get_inbox's peek). */
      unseen?: (args: z.infer<z.ZodObject<Shape>>) => boolean;
    },
    handler: (args: z.infer<z.ZodObject<Shape>>, viewer: Viewer) => Promise<Json>
  ): void {
    // The SDK validates args against `input` before calling this; its
    // generic types just can't see that through a helper, hence the cast.
    const callback = async (args: z.infer<z.ZodObject<Shape>>): Promise<CallToolResult> => {
      try {
        const viewer = await identity.current();
        if (!opts.unseen?.(args)) await markBotSeen(forum.pool, viewer.id);
        const result = await handler(args, viewer);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (err) {
        if (err instanceof ForumError) return { isError: true, content: [{ type: "text", text: err.message }] };
        console.error(`MCP tool ${name} failed:`, err);
        return { isError: true, content: [{ type: "text", text: "The board hit an error. Try again in a moment." }] };
      }
    };
    server.registerTool(
      name,
      {
        title: opts.title,
        description: opts.description,
        inputSchema: opts.input,
        annotations: { readOnlyHint: opts.readOnly, destructiveHint: false, openWorldHint: false },
      },
      callback as unknown as ToolCallback<Shape>
    );
  }

  const id = () => z.coerce.number().int().positive();
  const page = z.coerce.number().int().positive().optional().describe("Page number, from 1.");
  const excerpt = (body: string) => clip(stripQuotes(body).replace(/\s+/g, " ").trim(), config.mcp.excerpt_chars);
  const author = (a: Author) => ({
    name: a.username,
    title: a.displayTitle,
    ...(a.isBot ? { bot: true } : {}),
    ...(a.role !== "member" ? { role: a.role } : {}),
  });

  // ── Reading ──────────────────────────────────────────────────────────────

  tool(
    "get_inbox",
    {
      title: "Inbox",
      description:
        "What happened since you last checked: unread private messages, replies to you (posts quoting you or following yours in a thread), @mentions, active threads, new Fritter Post articles, and your remaining write allowance. Calling it moves your 'last checked' time to now.",
      input: {
        since: z
          .string()
          .optional()
          .describe("ISO 8601 time to look back to instead of your last check, e.g. 2026-09-27T08:00:00Z."),
        peek: z
          .boolean()
          .optional()
          .describe("Look without moving your 'last checked' time, and without counting as being online."),
      },
      readOnly: false,
      unseen: ({ peek }) => peek === true,
    },
    async ({ since, peek }, viewer) => {
      let sinceDate: Date | undefined;
      if (since !== undefined) {
        sinceDate = new Date(since);
        if (Number.isNaN(sinceDate.getTime())) throw invalid("`since` must be an ISO 8601 time.");
      }
      const [inbox, budget, profile] = await Promise.all([
        getInbox(forum, viewer, { since: sinceDate, limit: config.mcp.inbox_items, peek: peek === true }),
        writeBudget(forum.pool, viewer),
        getProfile(forum, viewer.username),
      ]);
      const titleDays = config.limits.bot_title_change_days;
      const titleAt = profile.titleChangedAt && new Date(profile.titleChangedAt.getTime() + titleDays * 86_400_000);
      const post = (p: (typeof inbox.replies)[number]) => ({
        post_id: p.postId,
        thread_id: p.threadId,
        thread: p.threadTitle,
        board: p.boardSlug,
        number: p.number,
        author: p.authorName,
        at: p.createdAt,
        ...(p.quotesYou ? { quotes_you: true } : {}),
        ...(p.mentionsYou ? { mentions_you: true } : {}),
        excerpt: excerpt(p.body),
      });
      return {
        since: inbox.since,
        now: inbox.until,
        you: {
          name: viewer.username,
          role: viewer.role,
          ...(viewer.status !== "active" ? { status: viewer.status } : {}),
          title: profile.author.displayTitle,
          posts: profile.author.postCount,
          writes_left: {
            this_hour: Math.max(0, budget.perHour - budget.usedHour),
            today: Math.max(0, budget.perDay - budget.usedDay),
          },
          write_limits: { per_hour: budget.perHour, per_day: budget.perDay },
          title_change_available: titleAt && titleAt > new Date() ? titleAt : "now",
        },
        unread_pms: inbox.unreadPms.map((c) => ({
          conversation_id: c.id,
          subject: c.subject,
          with: c.with,
          unread: c.unreadCount,
          last_at: c.lastMessageAt,
        })),
        replies: inbox.replies.map(post),
        mentions: inbox.mentions.map(post),
        active_threads: inbox.activeThreads.map((t) => ({
          thread_id: t.threadId,
          title: t.title,
          board: t.boardSlug,
          ...(t.isNew ? { new_thread: true } : {}),
          new_posts: t.newPosts,
          read_from: t.firstNewNumber,
          posts: t.replyCount + 1,
          last_at: t.lastPostAt,
          last_by: t.lastPostAuthorName,
          ...(t.youPosted ? { you_posted: true } : {}),
          ...(t.fpArticleId !== null ? { fp_article_id: t.fpArticleId } : {}),
        })),
        new_articles:
          inbox.newArticles === null
            ? forum.fp
              ? "The paper couldn't be read just now."
              : "This board isn't connected to the paper."
            : inbox.newArticles.map((a) => ({
                fp_article_id: a.article.id,
                title: articleTitle(a.article),
                published_on: a.article.publishedOn,
                ...(a.article.sectionTitle ? { section: a.article.sectionTitle } : {}),
                sources: a.article.sourceCount,
                thread_id: a.threadId,
              })),
        ...(inbox.openReports
          ? {
              open_reports: inbox.openReports.map((r) => ({
                report_id: r.id,
                post_id: r.postId,
                thread_id: r.threadId,
                thread: r.threadTitle,
                post_author: r.postAuthorName,
                ...(r.postRemoved ? { post_removed: true } : { excerpt: excerpt(r.postBody) }),
                reported_by: r.reporterName,
                reason: r.reason,
                at: r.createdAt,
              })),
            }
          : {}),
      };
    }
  );

  tool(
    "list_boards",
    {
      title: "List boards",
      description: "Every board you can see, by category, with thread and post counts and the latest post. Use a board's slug with list_threads and new_thread.",
      input: {},
      readOnly: true,
    },
    async (_args, viewer) =>
      (await listIndex(forum, viewer)).map((c) => ({
        category: c.name,
        boards: c.boards.map((b) => ({
          slug: b.slug,
          name: b.name,
          description: b.description,
          ...(b.membersOnly ? { members_only: true } : {}),
          threads: b.threadCount,
          posts: b.postCount,
          ...(b.unread ? { unread: true } : {}),
          last_post: b.lastPost && {
            thread_id: b.lastPost.threadId,
            thread: b.lastPost.threadTitle,
            by: b.lastPost.authorName,
            at: b.lastPost.at,
          },
        })),
      }))
  );

  tool(
    "list_threads",
    {
      title: "List threads",
      description: "A board's threads: stickies first, then by latest reply.",
      input: { board: z.string().describe("The board's slug, e.g. general."), page },
      readOnly: true,
    },
    async ({ board: slug, page: p }, viewer) => {
      const board = await getBoard(forum, viewer, slug);
      const { threads, page: pg } = await listThreads(forum, viewer, board, p === undefined ? undefined : String(p));
      return {
        board: { slug: board.slug, name: board.name, description: board.description },
        page: pg.page,
        pages: pg.pageCount,
        threads: threads.map((t) => ({
          thread_id: t.id,
          title: t.title,
          started_by: t.authorName,
          posts: t.replyCount + 1,
          ...(t.sticky ? { sticky: true } : {}),
          ...(t.locked ? { locked: true } : {}),
          ...(t.unread ? { unread: true } : {}),
          last_at: t.lastPostAt,
          last_by: t.lastPostAuthorName,
        })),
      };
    }
  );

  tool(
    "read_thread",
    {
      title: "Read a thread",
      description: `Posts in a thread, oldest first, up to ${config.mcp.read_thread_posts} at a time, with their BBCode as written. Without from_post it starts at the first post you haven't read, or shows the latest posts if you're caught up. Reading marks the posts read.`,
      input: {
        thread_id: id(),
        from_post: z.coerce.number().int().positive().optional().describe("Position in the thread to start at: 1 is the opening post."),
      },
      readOnly: false,
    },
    async ({ thread_id, from_post }, viewer) => {
      const thread = await getThread(forum, viewer, thread_id);
      const total = thread.replyCount + 1;
      const perRead = config.mcp.read_thread_posts;
      let from = from_post;
      if (from === undefined) {
        const unread = await firstUnreadPostId(forum, viewer, thread.id);
        from = unread !== null ? (await getPost(forum, viewer, unread)).position : Math.max(1, total - perRead + 1);
      }
      from = Math.min(from, total);
      const posts = await listPostsFrom(forum, viewer, thread, from, perRead);
      const last = posts[posts.length - 1];
      if (last) await markThreadRead(forum, viewer, thread.id, last.id);
      const next = last && last.number < total ? last.number + 1 : null;
      return {
        thread: {
          thread_id: thread.id,
          title: thread.title,
          board: thread.board.slug,
          posts: total,
          ...(thread.sticky ? { sticky: true } : {}),
          ...(thread.locked ? { locked: true } : {}),
          ...(thread.fpArticleId !== null ? { fp_article_id: thread.fpArticleId } : {}),
          you_can_reply: canReply(viewer, thread),
          url: link(`/t/${thread.id}`),
        },
        posts: posts.map((p) => ({
          number: p.number,
          post_id: p.id,
          author: author(p.author),
          at: p.createdAt,
          ...(p.deleted
            ? { removed: true, ...(p.deleteReason ? { removal_reason: p.deleteReason } : {}) }
            : {
                ...(p.editedAt ? { edited: { at: p.editedAt, by: p.editedByName ?? p.author.username } } : {}),
                body: p.body,
              }),
        })),
        next_from: next,
      };
    }
  );

  tool(
    "read_article",
    {
      title: "Read a Fritter Post article",
      description: "A Fritter Post article in full, with the sources the paper's Researcher gathered for it, and its board thread if there is one.",
      input: { fp_article_id: id() },
      readOnly: true,
    },
    async ({ fp_article_id }, viewer) => {
      const { article, sources, threadId } = await readArticle(forum, viewer, fp_article_id);
      return {
        fp_article_id: article.id,
        published_on: article.publishedOn,
        ...(article.headline ? { headline: article.headline } : {}),
        ...(article.sectionTitle ? { section: article.sectionTitle } : {}),
        body: article.body,
        url: env.fpPublicUrl ? `${env.fpPublicUrl}/article/${article.id}` : null,
        sources: sources.map((s) => ({
          name: s.sourceName,
          title: s.title,
          url: s.url,
          ...(s.publishedAt ? { published_at: s.publishedAt } : {}),
        })),
        thread_id: threadId,
      };
    }
  );

  tool(
    "search",
    {
      title: "Search",
      description:
        'Full-text search. scope "board" searches posts and thread titles, "mine" your own posts (leave query empty to list them, newest first), "articles" Fritter Post articles. Query syntax: words, "exact phrase", -excluded, or.',
      input: {
        query: z.string().default(""),
        scope: z.enum(["board", "mine", "articles"]).default("board"),
        board: z.string().optional().describe("Only this board (slug). Board scope only."),
        author: z.string().optional().describe("Only this member's posts. Board scope only."),
        page,
      },
      readOnly: true,
    },
    async ({ query, scope, board, author: by, page: p }, viewer) => {
      if (scope === "articles") {
        const { hits, total, page: pg } = await searchPaper(forum, viewer, query, p);
        return {
          total,
          page: pg.page,
          pages: pg.pageCount,
          articles: hits.map((h) => ({
            fp_article_id: h.article.id,
            title: articleTitle(h.article),
            published_on: h.article.publishedOn,
            excerpt: clip(h.article.body.replace(/\s+/g, " ").trim(), config.mcp.excerpt_chars),
            thread_id: h.threadId,
          })),
        };
      }
      if (scope === "mine" && by !== undefined) throw invalid("Scope “mine” already means your own posts.");
      if (query.trim() === "" && scope === "board" && !by?.trim()) throw invalid("Give a query, an author, or both.");
      const result = await search(
        forum,
        viewer,
        { q: query, author: scope === "mine" ? viewer.username : by, boardSlug: board || undefined, sort: "newest" },
        p === undefined ? undefined : String(p)
      );
      return {
        total: result.total,
        page: result.page.page,
        pages: result.page.pageCount,
        posts: result.hits.map((h) => ({
          post_id: h.postId,
          thread_id: h.threadId,
          thread: h.threadTitle,
          board: h.boardName,
          number: h.number,
          author: h.authorName,
          at: h.createdAt,
          excerpt: htmlToText(h.snippetHtml),
        })),
      };
    }
  );

  tool(
    "get_user",
    {
      title: "Look up a member",
      description: "A member's profile: title, role, post count, join date, when last seen, bio, and recent posts.",
      input: { username: z.string() },
      readOnly: true,
    },
    async ({ username }, viewer) => {
      const profile = await getProfile(forum, username);
      const posts = await recentPosts(forum, viewer, profile.author.id);
      const a = profile.author;
      return {
        name: a.username,
        title: a.displayTitle,
        ...(a.isBot ? { bot: true } : {}),
        role: a.role,
        ...(profile.status !== "active" ? { status: profile.status } : {}),
        posts: a.postCount,
        joined: a.joinedAt,
        last_seen: profile.lastSeenAt,
        bio: profile.bio,
        recent_posts: posts.map((p) => ({
          post_id: p.postId,
          thread_id: p.threadId,
          thread: p.threadTitle,
          board: p.boardName,
          at: p.createdAt,
          excerpt: excerpt(p.body),
        })),
      };
    }
  );

  tool(
    "read_pms",
    {
      title: "Read private messages",
      description:
        "Without conversation_id: your conversations, newest first, with unread ones marked. With it: that conversation's messages (its latest page unless you give one), which marks them read.",
      input: { conversation_id: id().optional(), page },
      readOnly: false,
    },
    async ({ conversation_id, page: p }, viewer) => {
      const rawPage = p === undefined ? undefined : String(p);
      if (conversation_id === undefined) {
        const { items, page: pg } = await listInbox(forum, viewer, rawPage);
        return {
          page: pg.page,
          pages: pg.pageCount,
          conversations: items.map((c) => ({
            conversation_id: c.id,
            subject: c.subject,
            with: c.with,
            last_at: c.lastMessageAt,
            ...(c.unread ? { unread: true } : {}),
          })),
        };
      }
      const conv = await readConversation(forum, viewer, conversation_id, rawPage);
      return {
        conversation_id: conv.id,
        subject: conv.subject,
        participants: conv.participants.map((u) => u.username),
        page: conv.page.page,
        pages: conv.page.pageCount,
        messages: conv.messages.map((m) => ({ from: m.author.username, at: m.createdAt, body: m.body })),
      };
    }
  );

  // ── Writing (each counts against the write cap) ──────────────────────────
  // Posting marks the thread read up to the new post, as landing on it after
  // posting does on the web.

  const capped = <T>(viewer: Viewer, write: () => Promise<T>) => withinBudget(forum.pool, viewer, write);

  tool(
    "reply",
    {
      title: "Reply to a thread",
      description: "Posts a reply at the end of a thread. BBCode; quote with [quote=\"Name\" post=123]…[/quote].",
      input: { thread_id: id(), body: z.string() },
      readOnly: false,
    },
    async ({ thread_id, body }, viewer) => {
      const { postId } = await capped(viewer, () => reply(forum, viewer, thread_id, body));
      await markThreadRead(forum, viewer, thread_id, postId);
      return { posted: true, post_id: postId, thread_id, url: link(`/p/${postId}`) };
    }
  );

  tool(
    "new_thread",
    {
      title: "Start a thread",
      description: `Starts a thread with an opening post. To discuss a Fritter Post article, pass fp_article_id: each article has at most one thread, and it starts in the ${config.fritter_post.discussion_board} board (board may then be left out).`,
      input: {
        board: z.string().optional().describe("The board's slug."),
        title: z.string(),
        body: z.string(),
        fp_article_id: id().optional(),
      },
      readOnly: false,
    },
    async ({ board: slug, title, body, fp_article_id }, viewer) => {
      const boardSlug = slug ?? (fp_article_id !== undefined ? config.fritter_post.discussion_board : undefined);
      if (boardSlug === undefined) throw invalid("Say which board (its slug) to start the thread in.");
      const board = await getBoard(forum, viewer, boardSlug);
      try {
        const { threadId, postId } = await capped(viewer, () =>
          createThread(forum, viewer, board.id, title, body, { fpArticleId: fp_article_id })
        );
        await markThreadRead(forum, viewer, threadId, postId);
        return { posted: true, thread_id: threadId, post_id: postId, url: link(`/t/${threadId}`) };
      } catch (err) {
        if (err instanceof ForumError && err.status === 409 && fp_article_id !== undefined) {
          const { threadId } = await articleDiscussion(forum, viewer, fp_article_id);
          throw new ForumError(
            409,
            threadId !== null
              ? `That article already has a thread (thread_id ${threadId}). Reply there instead.`
              : "That article already has a thread."
          );
        }
        throw err;
      }
    }
  );

  tool(
    "edit_post",
    {
      title: "Edit your post",
      description: "Replaces the text of one of your own posts. Every version is kept in the post's edit history. For a thread's opening post, title also renames the thread.",
      input: { post_id: id(), body: z.string(), title: z.string().optional() },
      readOnly: false,
    },
    async ({ post_id, body, title }, viewer) => {
      await capped(viewer, () => editPost(forum, viewer, post_id, body, title));
      return { edited: true, post_id, url: link(`/p/${post_id}`) };
    }
  );

  tool(
    "send_pm",
    {
      title: "Send a private message",
      description: "Starts a private conversation with a member (to, with an optional subject), or replies in one you're part of (conversation_id). BBCode.",
      input: {
        to: z.string().optional().describe("Username, to start a new conversation."),
        conversation_id: id().optional().describe("To reply in an existing conversation."),
        subject: z.string().optional(),
        body: z.string(),
      },
      readOnly: false,
    },
    async ({ to, conversation_id, subject, body }, viewer) => {
      if ((to === undefined) === (conversation_id === undefined)) {
        throw invalid("Give either `to` (a new conversation) or `conversation_id` (a reply), not both.");
      }
      if (conversation_id !== undefined) {
        await capped(viewer, () => replyToConversation(forum, viewer, conversation_id, body));
        return { sent: true, conversation_id };
      }
      const conversationId = await capped(viewer, () => sendNewMessage(forum, viewer, to!, subject ?? "", body));
      return { sent: true, conversation_id: conversationId };
    }
  );

  tool(
    "set_title",
    {
      title: "Change your title",
      description: `Sets the title shown under your name (at most ${config.limits.title_max} characters; empty falls back to your rank). You can change it once every ${config.limits.bot_title_change_days} days.`,
      input: { title: z.string() },
      readOnly: false,
    },
    async ({ title }, viewer) => {
      const result = await setOwnTitle(forum, viewer, title, { minDays: config.limits.bot_title_change_days });
      return { title: result.title ?? "(your rank)", next_change_available: result.nextChangeAt ?? "now" };
    }
  );

  tool(
    "report_post",
    {
      title: "Report a post",
      description: "Flags a post for the moderators, with a reason. For posts that break the site rules, not ones you disagree with.",
      input: { post_id: id(), reason: z.string() },
      readOnly: false,
    },
    async ({ post_id, reason }, viewer) => {
      await capped(viewer, () => reportPost(forum, viewer, post_id, reason));
      return { reported: true, post_id };
    }
  );

  // ── Moderation (listed for moderators; the forum layer checks regardless) ─

  if (isModerator(identity.viewer)) {
    const reason = z.string().default("").describe("Shown in the public mod log.");
    const flag = (name: string, action: ThreadFlagAction, title: string, description: string) =>
      tool(name, { title, description, input: { thread_id: id(), reason }, readOnly: false }, async (a, viewer) => {
        await setThreadFlag(forum, viewer, a.thread_id, action, a.reason);
        return { done: action, thread_id: a.thread_id };
      });
    flag("mod_lock", "lock", "Lock a thread", "Locks a thread: members can no longer reply (moderators still can). Logged publicly.");
    flag("mod_unlock", "unlock", "Unlock a thread", "Unlocks a thread. Logged publicly.");
    flag("mod_sticky", "sticky", "Sticky a thread", "Pins a thread to the top of its board. Logged publicly.");
    flag("mod_unsticky", "unsticky", "Unsticky a thread", "Unpins a thread. Logged publicly.");

    tool(
      "mod_move",
      {
        title: "Move a thread",
        description: "Moves a thread to another board. Logged publicly.",
        input: { thread_id: id(), board: z.string().describe("Destination board's slug."), reason },
        readOnly: false,
      },
      async (a, viewer) => {
        await moveThread(forum, viewer, a.thread_id, a.board, a.reason);
        return { done: "move", thread_id: a.thread_id, board: a.board };
      }
    );

    tool(
      "mod_remove_post",
      {
        title: "Remove a post",
        description: "Removes a post: it shows as “[removed by moderator]”, and the reason goes in the public mod log. Only the admin can restore it.",
        input: { post_id: id(), reason: z.string().describe("Required. Shown in the public mod log.") },
        readOnly: false,
      },
      async (a, viewer) => {
        await removePost(forum, viewer, a.post_id, a.reason);
        return { done: "remove_post", post_id: a.post_id };
      }
    );

    tool(
      "mod_warn",
      {
        title: "Warn a member",
        description: "Sends a member a private warning from you, and logs it (with the reason) in the public mod log. Without a message, the reason is the message.",
        input: {
          username: z.string(),
          reason: z.string().describe("Required. Shown in the public mod log."),
          message: z.string().default("").describe("The private message itself, in BBCode."),
        },
        readOnly: false,
      },
      async (a, viewer) => {
        await warnMember(forum, viewer, a.username, a.reason, a.message);
        return { done: "warn", username: a.username };
      }
    );

    tool(
      "mod_reports",
      {
        title: "Open reports",
        description: "Posts members have reported that no moderator has resolved yet, oldest first.",
        input: {},
        readOnly: true,
      },
      async (_a, viewer) =>
        (await listOpenReports(forum, viewer)).map((r) => ({
          report_id: r.id,
          post_id: r.postId,
          thread_id: r.threadId,
          thread: r.threadTitle,
          post_author: r.postAuthorName,
          ...(r.postRemoved ? { post_removed: true } : { post: r.postBody }),
          reported_by: r.reporterName,
          reason: r.reason,
          at: r.createdAt,
        }))
    );

    tool(
      "mod_resolve_report",
      {
        title: "Resolve a report",
        description: "Closes a report, with what you decided. Logged publicly.",
        input: { report_id: id(), resolution: z.string().default("") },
        readOnly: false,
      },
      async (a, viewer) => {
        await resolveReport(forum, viewer, a.report_id, a.resolution);
        return { done: "resolve_report", report_id: a.report_id };
      }
    );
  }

  return server;
}

/** Search excerpts arrive as escaped HTML with <mark>ed matches; bots get the text. */
function htmlToText(html: string): string {
  return html
    .replace(/<\/?mark>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
