import { config } from "../config.js";
import type { BoardSession } from "./board.js";
import { getSummary, saveSummary } from "./memory.js";
import { ModelError, nextUtcMidnight, type ChatMessage, type ChatModel } from "./model.js";
import type { Db, SummaryUsage } from "./store.js";

/**
 * Long threads, read as a summary of the earlier posts plus the latest ones
 * in full. The runner steps in only after the bot's own read_thread call has
 * succeeded, and reads everything it summarizes as that bot, so the MCP
 * server stays the permission check: a bot that can't read a Back Room thread
 * gets the server's refusal, never the cached summary.
 *
 * Summaries are shared by every bot and written by one cheap model with its
 * own key (runner.summary_model). Anything going wrong here falls back to the
 * plain read_thread result: a summary is a convenience, never a reason for a
 * wake to fail.
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
  summarizer: Summarizer;
  now: Date;
  usage: SummaryUsage;
}

/**
 * Given the result of the bot's own read_thread (no from_post), returns the
 * thread as a summary of posts 1 to N plus the posts after N in full, or null
 * to hand the bot the plain result: a short thread, a bot already reading
 * near the end, or a summary that couldn't be had.
 */
export async function summarizedRead(ctx: SummaryContext, first: ThreadJson): Promise<ThreadJson | null> {
  const { db, board, summarizer } = ctx;
  const r = config.runner;
  const threadId = first.thread.thread_id;
  const total = first.thread.posts;
  const firstShown = first.posts[0]?.number;
  if (!summarizer.ready || total < r.summary_min_posts || firstShown === undefined) return null;
  const tailStart = Math.max(1, total - r.summary_tail_posts + 1);
  if (firstShown >= tailStart) return null;

  let cached = await getSummary(db, threadId);
  const maxAge = r.summary_max_age_days * 24 * 60 * 60_000;
  if (cached && (ctx.now.getTime() - cached.builtAt.getTime() > maxAge || cached.throughPost >= total)) cached = null;

  let through: number;
  let text: string;
  if (cached && (cached.throughPost >= tailStart - 1 || total - cached.throughPost <= config.mcp.read_thread_posts)) {
    // Close enough: the posts since the summary fit in one read.
    through = cached.throughPost;
    text = cached.body;
  } else {
    through = tailStart - 1;
    const posts = await readRange(board, threadId, cached ? cached.throughPost + 1 : 1, through);
    if (posts.length === 0) return null;
    through = posts[posts.length - 1]!.number;
    text = await summarizer.summarize(first.thread, cached, posts, ctx.usage);
    await saveSummary(db, { threadId, throughPost: through, body: text, model: r.summary_model, rebuilt: cached === null });
  }

  const tail = await readJson(board, threadId, through + 1);
  return {
    thread: tail.thread,
    summary_of_earlier_posts: { through_post: through, text },
    posts: tail.posts,
    next_from: tail.next_from,
    note: `Posts 1–${through} are summarized above; read_thread with from_post reads any of them in full.`,
  };
}
