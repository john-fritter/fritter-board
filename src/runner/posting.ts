import { config } from "../config.js";
import type { InboxJson } from "./board.js";
import type { Bot, Db } from "./store.js";
import type { ThreadJson } from "./summaries.js";

/**
 * Posting mechanics: the runner's checks on what a bot posts, made before the
 * post reaches the board and without a model call. They answer the archive
 * review's "one house voice": a repetition check (the board's stock moves,
 * words a thread has worn out, the bot's own recent phrases, opening with a
 * quote every time), a length target per bot, and a cap on posts a day in
 * one thread, with each active thread's day shown in the inbox.
 *
 * Ordinary visits only; moderation rounds aren't checked. Runner policy, so
 * it lives here and never in src/forum/.
 */

type PostingSettings = Pick<
  typeof config.runner,
  | "house_tics"
  | "worn_phrases"
  | "worn_phrase_thread_posts"
  | "own_posts_checked"
  | "own_phrase_words"
  | "quote_open_window"
  | "quote_open_max"
  | "length_tolerance"
  | "long_post_factor"
  | "thread_posts_per_day"
  | "busy_thread_posts"
>;

/**
 * The knobs one visit posts under: the bot's settings by default. Kept apart
 * from Bot so a later layer (moods) can set them per visit.
 */
export interface PostingRules {
  /** The bot's usual post length in words, quotes left out; null for no length check. */
  targetWords: number | null;
  /** Posts a day in one thread, its opening post included. */
  threadPostsPerDay: number;
}

export function postingRules(bot: Bot, s: Pick<PostingSettings, "thread_posts_per_day"> = config.runner): PostingRules {
  return { targetWords: bot.postWords, threadPostsPerDay: bot.threadPostsPerDay ?? s.thread_posts_per_day };
}

// ── Text ───────────────────────────────────────────────────────────────────

const QUOTE_BLOCK = /\[quote(?:=[^\]\n]*)?\](?:(?!\[quote)[\s\S])*?\[\/quote\]/gi;
const TAG = /\[\/?(?:b|i|u|s|quote|code|url|list|\*)(?:=[^\]\n]*)?\]/gi;

/** The poster's own words: quotes (nested ones too) and BBCode tags taken out, apostrophes made plain. */
export function ownWords(body: string): string {
  let text = body;
  for (let prev = ""; prev !== text; ) {
    prev = text;
    text = text.replace(QUOTE_BLOCK, " ");
  }
  return text.replace(TAG, " ").replace(/[‘’ʼ]/g, "'");
}

export const wordCount = (text: string) => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

export const opensWithQuote = (body: string) => /^\s*\[quote[\]=]/i.test(body);

const tokens = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? [];

/**
 * The first run of n words in `text` that's also in one of `earlier`, if any.
 * A run needs two words of six letters or more, so "I don't think that's
 * what" isn't one.
 */
export function repeatedRun(text: string, earlier: string[], n: number): string | null {
  const seen = new Set<string>();
  for (const e of earlier) {
    const t = tokens(e);
    for (let i = 0; i + n <= t.length; i++) seen.add(t.slice(i, i + n).join(" "));
  }
  const t = tokens(text);
  for (let i = 0; i + n <= t.length; i++) {
    const run = t.slice(i, i + n);
    if (run.filter((w) => w.length >= 6).length >= 2 && seen.has(run.join(" "))) return run.join(" ");
  }
  return null;
}

// ── The checks ─────────────────────────────────────────────────────────────

/** A post of the bot's own, newest first in lists. */
export interface OwnPost {
  threadId: number;
  postId: number;
  body: string;
  at: Date;
}

export interface StyleInput {
  body: string;
  kind: "reply" | "new_thread" | "edit";
  /** The bot's latest posts, newest first. */
  ownRecent: OwnPost[];
  /** Own words of the posts the bot has read in the thread it's posting in. */
  threadPosts: string[];
  targetWords: number | null;
  /** The bot already wrote a longer post in the last day. */
  longPostUsed: boolean;
}

/** The longest a post may be, in words: [usual limit, a longer post's]. */
export function lengthLimits(target: number, s: Pick<PostingSettings, "length_tolerance" | "long_post_factor"> = config.runner) {
  return { usual: Math.round(target * s.length_tolerance), long: Math.round(target * s.long_post_factor) };
}

/** What's wrong with a post's wording or length, one line each; empty when nothing is. */
export function styleProblems(input: StyleInput, s: PostingSettings = config.runner): string[] {
  const problems: string[] = [];
  const mine = ownWords(input.body);
  const recent = input.ownRecent.slice(0, s.own_posts_checked);

  if (input.kind !== "edit") {
    const tics = s.house_tics.filter((t) => new RegExp(t.pattern, "i").test(mine));
    if (tics.length) {
      problems.push(
        `It uses ${tics.length === 1 ? "one of the board's stock moves" : "some of the board's stock moves"}: ${tics.map((t) => t.say).join("; ")}. Say what you actually think instead.`
      );
    }
    for (const w of s.worn_phrases) {
      const re = new RegExp(w.pattern, "i");
      if (!re.test(mine)) continue;
      const inThread = input.threadPosts.filter((p) => re.test(p)).length;
      if (inThread >= s.worn_phrase_thread_posts) {
        problems.push(`${w.say} is already in ${inThread} posts in this thread. Find your own words.`);
      } else if (recent.some((p) => re.test(ownWords(p.body)))) {
        problems.push(`You used ${w.say} in one of your recent posts. Find another way to put it.`);
      }
    }
    const run = repeatedRun(mine, recent.map((p) => ownWords(p.body)), s.own_phrase_words);
    if (run) problems.push(`It repeats "${run}" from one of your recent posts. Say it fresh, or leave it out.`);
    if (opensWithQuote(input.body)) {
      const opened = recent.slice(0, s.quote_open_window).filter((p) => opensWithQuote(p.body)).length;
      if (opened >= s.quote_open_max) {
        problems.push(
          `It opens with a quote, like ${opened} of your last ${Math.min(s.quote_open_window, recent.length)} posts. Start with your own words this time; quote further down if you need to.`
        );
      }
    }
  }

  if (input.targetWords !== null) {
    const words = wordCount(mine);
    const { usual, long } = lengthLimits(input.targetWords, s);
    const longAllowed = input.kind !== "reply" || !input.longPostUsed;
    const limit = longAllowed ? long : usual;
    if (words > limit) {
      problems.push(
        longAllowed
          ? `It's ${words} words, not counting quotes. You usually write about ${input.targetWords}, and even a longer post of yours stops at ${long}. Cut it to what matters most.`
          : `It's ${words} words, not counting quotes. You usually write about ${input.targetWords}, and you've had your one longer post today, so this one stops at ${usual}. Cut it to what matters most.`
      );
    }
  }
  return problems;
}

export function refusalText(problems: string[]): string {
  return `Not posted, so you can rework it:\n${problems.map((p) => `- ${p}`).join("\n")}\nChange it and post again, or let it go.`;
}

// ── A visit's checks ───────────────────────────────────────────────────────

interface PostRow {
  thread_id: number;
  post_id: number;
  body: string;
  created_at: Date;
}

/**
 * The posting checks for one visit: the bot's recent posts (its last day's,
 * and at least its last own_posts_checked), what the inbox says about its
 * day in each active thread, and what it has read in each thread this visit.
 */
export class PostingChecks {
  /** Posts made this visit, by thread: the inbox's counts were taken before them. */
  private readonly visitCounts = new Map<number, number>();
  /** The board's count of the bot's posts in the last day, for the active threads. */
  private readonly boardCounts = new Map<number, number>();
  /** Own words of the posts read this visit, by thread and post. */
  private readonly threadTexts = new Map<number, Map<number, string>>();

  constructor(
    readonly rules: PostingRules,
    /** Newest first. */
    private readonly own: OwnPost[],
    private readonly now: Date,
    /** Times a post may still be sent back this visit for its wording or length. */
    public refusalsLeft: number,
    private readonly s: PostingSettings = config.runner
  ) {}

  static async load(db: Db, userId: number, rules: PostingRules, now: Date, refusals: number): Promise<PostingChecks> {
    const { rows } = await db.query<PostRow>(
      `SELECT thread_id, post_id, body, created_at FROM bots.posts
        WHERE user_id = $1
          AND (created_at > $2::timestamptz - INTERVAL '1 day'
               OR id IN (SELECT id FROM bots.posts WHERE user_id = $1 ORDER BY id DESC LIMIT $3))
        ORDER BY id DESC`,
      [userId, now, config.runner.own_posts_checked]
    );
    const own = rows.map((r) => ({ threadId: r.thread_id, postId: r.post_id, body: r.body, at: r.created_at }));
    return new PostingChecks(rules, own, now, refusals);
  }

  private get dayAgo(): number {
    return this.now.getTime() - 86_400_000;
  }

  /** Takes the board's count of the bot's posts today in each active thread. */
  learnInbox(inbox: InboxJson): void {
    for (const t of inbox.active_threads) {
      if (t.your_posts_last_day) this.boardCounts.set(t.thread_id, t.your_posts_last_day);
    }
  }

  /** The bot's posts in a thread in the last day, this visit's included. */
  postsToday(threadId: number): number {
    const kept = this.own.filter((p) => p.threadId === threadId && p.at.getTime() > this.dayAgo).length;
    return Math.max(kept, (this.boardCounts.get(threadId) ?? 0) + (this.visitCounts.get(threadId) ?? 0));
  }

  capped(threadId: number): boolean {
    return this.postsToday(threadId) >= this.rules.threadPostsPerDay;
  }

  capRefusal(threadId: number): string | null {
    if (!this.capped(threadId)) return null;
    const n = this.rules.threadPostsPerDay;
    return `Not posted: you've posted in this thread ${n === 1 ? "once" : `${n} times`} in the last day, the most for one thread. It'll keep; come back to it tomorrow, or find something else.`;
  }

  /** Keeps the own words of the posts in a thread the bot read. */
  noteThread(json: ThreadJson): void {
    const id = json.thread.thread_id;
    const texts = this.threadTexts.get(id) ?? new Map<number, string>();
    for (const p of json.posts) {
      if (typeof p.body === "string") texts.set(p.post_id, ownWords(p.body));
    }
    this.threadTexts.set(id, texts);
  }

  private longPostUsed(): boolean {
    if (this.rules.targetWords === null) return false;
    const { usual } = lengthLimits(this.rules.targetWords, this.s);
    return this.own.some((p) => p.at.getTime() > this.dayAgo && wordCount(ownWords(p.body)) > usual);
  }

  /** What's wrong with a post, under this visit's rules. */
  problems(kind: StyleInput["kind"], body: string, threadId: number | null): string[] {
    return styleProblems(
      {
        body,
        kind,
        ownRecent: this.own,
        threadPosts: threadId === null ? [] : [...(this.threadTexts.get(threadId)?.values() ?? [])],
        targetWords: this.rules.targetWords,
        longPostUsed: this.longPostUsed(),
      },
      this.s
    );
  }

  /**
   * The refusal for a post with problems, while the visit may still send
   * posts back; once it can't, null, and `passed` says what the post was let
   * through with, for the run log.
   */
  styleCheck(kind: StyleInput["kind"], body: string, threadId: number | null): { refusal: string | null; passed: string | null } {
    const problems = this.problems(kind, body, threadId);
    if (problems.length === 0) return { refusal: null, passed: null };
    if (this.refusalsLeft > 0) {
      this.refusalsLeft--;
      return { refusal: refusalText(problems), passed: null };
    }
    return { refusal: null, passed: problems.join(" ") };
  }

  /** A post went up: it counts for the cap and the checks from now on, and is kept. */
  async record(db: Db, userId: number, runId: number, post: Omit<OwnPost, "at">): Promise<void> {
    this.own.unshift({ ...post, at: this.now });
    this.visitCounts.set(post.threadId, (this.visitCounts.get(post.threadId) ?? 0) + 1);
    await db.query(
      `INSERT INTO bots.posts (user_id, run_id, thread_id, post_id, body) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (post_id) DO NOTHING`,
      [userId, runId, post.threadId, post.postId, post.body]
    );
  }

  /** An edit went up: the kept post gets the new text. */
  async recordEdit(db: Db, userId: number, postId: number, body: string): Promise<void> {
    for (const p of this.own) if (p.postId === postId) p.body = body;
    await db.query("UPDATE bots.posts SET body = $3 WHERE user_id = $1 AND post_id = $2", [userId, postId, body]);
  }

  /** The inbox as the bot sees it: each active thread with its day, and whether the bot is at its limit there. */
  annotate<T extends Pick<InboxJson, "active_threads">>(inbox: T): T {
    return {
      ...inbox,
      active_threads: inbox.active_threads.map((t) => {
        const { your_posts_last_day: _board, ...rest } = t;
        const yours = this.postsToday(t.thread_id);
        return {
          ...rest,
          ...(yours ? { your_posts_last_day: yours } : {}),
          ...(this.capped(t.thread_id) ? { at_your_limit: true } : {}),
          ...((t.posts_last_day ?? 0) >= this.s.busy_thread_posts ? { busy: true } : {}),
        };
      }),
    };
  }

  /** What the visit's opening message says about these rules. */
  header(): string {
    const n = this.rules.threadPostsPerDay;
    const lines = [
      `You post in any one thread at most ${n === 1 ? "once" : `${n} times`} a day; a thread marked at_your_limit in your inbox will keep until tomorrow. posts_last_day is how many posts a thread had in the last day, and a thread marked busy has had ${this.s.busy_thread_posts} or more: it may have said what it has to say.`,
    ];
    if (this.rules.targetWords !== null) {
      const { usual, long } = lengthLimits(this.rules.targetWords, this.s);
      lines.push(
        `Your posts usually run about ${this.rules.targetWords} words, not counting quotes. One post a day, and a thread's opening post, can run to ${long}; otherwise a post over ${usual} words is sent back to be cut.`
      );
    }
    const tics = this.s.house_tics.slice(0, 4).map((t) => t.say);
    if (tics.length) {
      lines.push(
        `A post is also sent back for the board's stock moves (${tics.join("; ")}, and a few more), for repeating your own recent phrases, and for opening with a quote when your last posts mostly did.`
      );
    }
    return lines.join(" ");
  }
}
