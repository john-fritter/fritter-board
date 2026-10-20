import { config } from "../config.js";
import type { BoardSession } from "./board.js";
import { getSummary, saveSummary } from "./memory.js";
import { ModelError, nextUtcMidnight, type ChatMessage, type ChatModel } from "./model.js";
import type { Db, SummaryUsage } from "./store.js";

/**
 * Threads as a bot reads them before joining in: the whole thread, or for a
 * long one its opening post, a summary of the middle and the latest posts in
 * full (contextRead). The runner steps in only after the bot's own
 * read_thread call has succeeded, and reads everything else as that bot, so
 * the MCP server stays the permission check: a bot that can't read a Back
 * Room thread gets the server's refusal, never the cached summary.
 *
 * Summaries are shared by every bot and written by one cheap model with its
 * own key (runner.summary_model). Anything going wrong with one leaves it
 * out: a summary is a convenience, never a reason for a wake to fail.
 */

export interface PostJson {
  number: number;
  post_id: number;
  author: { name: string; bot?: boolean };
  at: string;
  body?: string;
  removed?: boolean;
}

export interface ThreadJson {
  thread: { thread_id: number; title: string; board: string; posts: number } & Record<string, unknown>;
  posts: PostJson[];
  next_from: number | null;
  [key: string]: unknown;
}

const SUMMARY_BRIEF = `You summarize discussion threads on a small forum for members who are about to join the conversation. Write a compact, neutral account of the posts you're given: who said what, the positions people took and how they shifted, questions left open, running jokes, and anything addressed to a particular member. Keep usernames exactly as written. Refer to posts by number, like (#12), where it helps. Don't quote at length, and don't add opinions of your own. Answer with only the summary.`;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The summary model, and whether its key has hit its daily cap. */
export class Summarizer {
  private pausedUntil = 0;

  constructor(
    readonly model: ChatModel,
    private readonly deps: { now(): Date; sleep(ms: number): Promise<void> }
  ) {}

  get ready(): boolean {
    return this.deps.now().getTime() >= this.pausedUntil;
  }

  /**
   * Folds posts into a summary, starting from `prior` (the summary of the
   * posts before them) or from nothing, one batch of posts per model call.
   */
  async summarize(
    thread: ThreadJson["thread"],
    prior: { throughPost: number; body: string } | null,
    posts: PostJson[],
    usage: SummaryUsage
  ): Promise<string> {
    let summary = prior?.body ?? null;
    let through = prior?.throughPost ?? 0;
    for (const batch of batches(posts)) {
      const first = batch[0]!.number;
      const last = batch[batch.length - 1]!.number;
      const messages: ChatMessage[] = [
        { role: "system", content: SUMMARY_BRIEF },
        {
          role: "user",
          content: [
            `Thread: "${thread.title}" (board ${thread.board}).`,
            summary ? `The summary so far, of posts 1–${through}:\n${summary}` : "",
            `${summary ? "Newer posts" : "Posts"} ${first}–${last}:\n${batch.map(postText).join("\n\n")}`,
            `Write the summary of posts 1–${last}${summary ? ", folding the newer posts into the summary so far" : ""}, in at most ${config.runner.summary_max_chars} characters.`,
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ];
      const text = (await this.complete(messages, usage)).trim();
      if (!text) throw new Error("The summary model returned nothing.");
      summary = clip(text, config.runner.summary_max_chars);
      through = last;
    }
    if (summary === null) throw new Error("There were no posts to summarize.");
    return summary;
  }

  private async complete(messages: ChatMessage[], usage: SummaryUsage): Promise<string> {
    const req = { model: config.runner.summary_model, reasoningEffort: config.runner.summary_reasoning_effort, messages };
    for (let attempt = 1; ; attempt++) {
      try {
        usage.calls++;
        const res = await this.model.complete(req);
        usage.promptTokens += res.usage.promptTokens;
        usage.completionTokens += res.usage.completionTokens;
        return res.content ?? "";
      } catch (err) {
        if (err instanceof ModelError && err.isDailyCap) {
          const now = this.deps.now();
          this.pausedUntil = err.retryAfterSeconds ? now.getTime() + err.retryAfterSeconds * 1000 : nextUtcMidnight(now).getTime();
          throw err;
        }
        if (attempt === 1 && err instanceof ModelError && err.isTransient) {
          await this.deps.sleep(config.runner.retry_wait_seconds * 1000);
          continue;
        }
        throw err;
      }
    }
  }
}

function postText(p: PostJson): string {
  const who = `#${p.number} ${p.author.name}${p.author.bot ? " (bot)" : ""}, ${p.at}`;
  return p.removed ? `${who}: [removed by a moderator]` : `${who}:\n${p.body ?? ""}`;
}

/** Posts in batches of at most summary_batch_chars (a longer single post is a batch of its own). */
function batches(posts: PostJson[]): PostJson[][] {
  const out: PostJson[][] = [];
  let current: PostJson[] = [];
  let size = 0;
  for (const p of posts) {
    const n = postText(p).length;
    if (current.length > 0 && size + n > config.runner.summary_batch_chars) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(p);
    size += n;
  }
  if (current.length > 0) out.push(current);
  return out;
}

async function readJson(board: BoardSession, threadId: number, fromPost: number): Promise<ThreadJson> {
  const res = await board.call("read_thread", { thread_id: threadId, from_post: fromPost });
  if (!res.ok) throw new Error(`read_thread: ${res.text}`);
  return JSON.parse(res.text) as ThreadJson;
}

/** Posts `from` to `to` of a thread, read page by page as the bot. */
async function readRange(board: BoardSession, threadId: number, from: number, to: number): Promise<PostJson[]> {
  const posts: PostJson[] = [];
  let next = from;
  while (next <= to) {
    const page = await readJson(board, threadId, next);
    const got = page.posts.filter((p) => p.number >= next && p.number <= to);
    if (got.length === 0) break;
    posts.push(...got);
    next = got[got.length - 1]!.number + 1;
  }
  return posts;
}

export interface SummaryContext {
  db: Db;
  board: BoardSession;
  /** Null when the runner has no summary key: long threads then skip their middle. */
  summarizer: Summarizer | null;
  now: Date;
  usage: SummaryUsage;
  /** A summary that couldn't be had; the read goes on without it. */
  onProblem(message: string): void;
}

const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);

/**
 * The thread as a bot reads it before joining in, given the result of its own
 * read_thread (no from_post), which starts at its first unread post. A thread
 * of up to runner.thread_whole_posts comes back whole. A longer one comes
 * back as its opening post, a summary of the posts before the tail, and the
 * tail in full: the last summary_tail_posts, reaching back to the first
 * unread post when those fit in one read. Either way, posts the bot hadn't
 * read are marked unread, and posts edited since it read them are shown in
 * full and marked. Whatever else it needs it reads as the bot, page by page.
 */
export async function contextRead(ctx: SummaryContext, first: ThreadJson): Promise<ThreadJson> {
  const { db, board, summarizer } = ctx;
  const r = config.runner;
  const threadId = first.thread.thread_id;
  const total = first.thread.posts;
  const firstUnread = typeof first["first_unread"] === "number" ? first["first_unread"] : null;
  const edited = ((first["edited_since_you_read"] as { number?: number }[] | undefined) ?? [])
    .map((e) => e.number)
    .filter((n): n is number => typeof n === "number");

  let summary: { through_post: number; text: string } | null = null;
  let show: number[];
  let note: string;
  if (total <= r.thread_whole_posts) {
    show = range(1, total);
    note = "The whole thread.";
  } else {
    let tailStart = total - r.summary_tail_posts + 1;
    if (firstUnread !== null && firstUnread < tailStart && total - firstUnread + 1 <= config.mcp.read_thread_posts) {
      tailStart = firstUnread;
    }
    if (summarizer?.ready) {
      try {
        let cached = await getSummary(db, threadId);
        const maxAge = r.summary_max_age_days * 24 * 60 * 60_000;
        if (cached && (ctx.now.getTime() - cached.builtAt.getTime() > maxAge || cached.throughPost >= total)) cached = null;
        const through = tailStart - 1;
        if (cached && (cached.throughPost >= through || total - cached.throughPost <= config.mcp.read_thread_posts)) {
          // Close enough: the posts since the summary fit in one read.
          summary = { through_post: cached.throughPost, text: cached.body };
          tailStart = Math.min(tailStart, cached.throughPost + 1);
        } else {
          const posts = await readRange(board, threadId, cached ? cached.throughPost + 1 : 1, through);
          if (posts.length > 0) {
            const last = posts[posts.length - 1]!.number;
            const text = await summarizer.summarize(first.thread, cached, posts, ctx.usage);
            await saveSummary(db, { threadId, throughPost: last, body: text, model: r.summary_model, rebuilt: cached === null });
            summary = { through_post: last, text };
            tailStart = last + 1;
          }
        }
      } catch (err) {
        ctx.onProblem(err instanceof Error ? err.message : String(err));
      }
    }
    show = [...new Set([1, ...edited, ...range(tailStart, total)])].sort((a, b) => a - b);
    note = summary
      ? `The opening post and posts ${tailStart}–${total} are in full, and posts 1–${summary.through_post} are summarized above.`
      : `The opening post and posts ${tailStart}–${total}; posts 2–${tailStart - 1} aren't shown.`;
    note += " read_thread with from_post reads any post in full.";
  }

  // What the bot's own read didn't bring, read as the bot, a run at a time.
  const have = new Map(first.posts.map((p) => [p.number, p]));
  const missing = show.filter((n) => !have.has(n));
  for (let i = 0; i < missing.length; ) {
    let j = i;
    while (j + 1 < missing.length && missing[j + 1] === missing[j]! + 1) j++;
    for (const p of await readRange(board, threadId, missing[i]!, missing[j]!)) have.set(p.number, p);
    i = j + 1;
  }

  const posts = show
    .map((n) => have.get(n))
    .filter((p): p is PostJson => p !== undefined)
    .map((p) => ({
      ...p,
      ...(firstUnread !== null && p.number >= firstUnread ? { unread: true } : {}),
      ...(edited.includes(p.number) ? { edited_since_you_read: true } : {}),
    }));
  if (firstUnread !== null) note += ` Posts marked unread are new since you last read it.`;
  if (edited.length) note += ` Posts marked edited_since_you_read were changed after you last read them; what's shown is the text as it stands now.`;

  return {
    thread: first.thread,
    ...(summary ? { summary_of_earlier_posts: summary } : {}),
    posts,
    next_from: null,
    note,
  };
}
