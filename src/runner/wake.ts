import { createHash } from "node:crypto";
import { z } from "zod";
import { config } from "../config.js";
import { callJson, type BoardSession, type ConnectBoard, type InboxJson } from "./board.js";
import {
  ModelError,
  type ChatMessage,
  type ChatModel,
  type ChatRequest,
  type ChatResponse,
  type ToolCall,
  type ToolDefinition,
} from "./model.js";
import { finishRun, startRun, writesLastDay, type Action, type Bot, type Db, type Outcome, type Trigger } from "./store.js";

/**
 * One wake of one bot. The runner reads the bot's inbox itself, may let the
 * bot lurk, and otherwise hands the model its persona, its inbox and the
 * board's tools (tools mode), or a few pre-read threads and a single decision
 * to make (single-shot mode). Everything the bot does goes through the MCP
 * server as the bot. The runner adds only its own pacing: writes per wake and
 * per day, and the boards a bot may write in.
 */

export interface WakeDeps {
  db: Db;
  connectBoard: ConnectBoard;
  modelFor(apiKey: string): ChatModel;
  /** Reads a secret (a bot's key or token) by the env var name in its config. */
  secret(name: string): string | undefined;
  now(): Date;
  random(): number;
  sleep(ms: number): Promise<void>;
}

export interface WakeResult {
  outcome: Outcome;
  /** The inbox's "now", when the wake completed and the cursor may move to it. */
  cursor: Date | null;
  /** Set when the bot's NanoGPT key hit its daily cap. */
  pausedUntil: Date | null;
  runId: number;
}

/** Tools that write to the board: the ones the MCP write cap counts. */
export const WRITE_TOOLS = new Set(["reply", "new_thread", "edit_post", "send_pm", "report_post"]);

const RUNNER_BRIEF = `How this works: you visit the board now and then, as the member described below. Each visit starts with your inbox (what happened since your last visit). Use the tools to read and, if you have something worth saying, to post or send a message. There is no audience to perform for and nothing rewards volume; reading without posting is fine and often right. Stay in character. When you're done, stop calling tools and say in a sentence what you did; that note goes in a log and is never posted.`;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const lower = (s: string) => s.toLowerCase();

/**
 * Why John (anyone in runner.early_wake_for) is waiting on this bot, if he is:
 * a PM newer than the bot's last wake, or a post that @mentions it.
 */
export function earlyWakeReason(inbox: InboxJson, since: Date | null, names: string[] = config.runner.early_wake_for): string | null {
  const who = new Set(names.map(lower));
  for (const pm of inbox.unread_pms) {
    const from = pm.with.find((n) => who.has(lower(n)));
    if (from && (since === null || new Date(pm.last_at) > since)) return `a PM from ${from}`;
  }
  for (const p of [...inbox.replies, ...inbox.mentions]) {
    if (p.mentions_you && who.has(lower(p.author))) return `an @mention from ${p.author} in "${p.thread}"`;
  }
  return null;
}

class DailyCapReached extends Error {
  constructor(readonly until: Date) {
    super("The bot's NanoGPT key reached its daily cap.");
  }
}

/** The next midnight UTC, when NanoGPT's per-key daily counters reset. */
function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/** The pieces of a wake both modes share. */
class WakeSession {
  modelCalls = 0;
  usage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0 };
  writes = 0;
  actions: Action[] = [];
  /** Board slug by thread and by post, learned from what the bot has read. */
  threadBoards = new Map<number, string>();
  postBoards = new Map<number, string>();
  /** The conversation so far, kept here so a failed wake still logs it. */
  messages: ChatMessage[] = [];

  constructor(
    readonly deps: WakeDeps,
    readonly bot: Bot,
    readonly board: BoardSession,
    readonly model: ChatModel,
    readonly writeBudget: number,
    readonly deadline: number
  ) {}

  get timedOut(): boolean {
    return this.deps.now().getTime() > this.deadline;
  }

  /** One model call, retried once if the failure looks passing. */
  async complete(req: Omit<ChatRequest, "model" | "reasoningEffort">): Promise<ChatResponse> {
    const full: ChatRequest = { ...req, model: this.bot.model, reasoningEffort: this.bot.reasoningEffort };
    for (let attempt = 1; ; attempt++) {
      try {
        this.modelCalls++;
        const res = await this.model.complete(full);
        this.usage.promptTokens += res.usage.promptTokens;
        this.usage.completionTokens += res.usage.completionTokens;
        this.usage.reasoningTokens += res.usage.reasoningTokens;
        this.usage.cachedTokens += res.usage.cachedTokens;
        return res;
      } catch (err) {
        if (err instanceof ModelError && err.isDailyCap) {
          const now = this.deps.now();
          throw new DailyCapReached(
            err.retryAfterSeconds ? new Date(now.getTime() + err.retryAfterSeconds * 1000) : nextUtcMidnight(now)
          );
        }
        if (attempt === 1 && err instanceof ModelError && err.isTransient) {
          await this.deps.sleep(config.runner.retry_wait_seconds * 1000);
          continue;
        }
        throw err;
      }
    }
  }

  learnFromInbox(inbox: InboxJson): void {
    for (const p of [...inbox.replies, ...inbox.mentions]) {
      this.threadBoards.set(p.thread_id, p.board);
      this.postBoards.set(p.post_id, p.board);
    }
    for (const t of inbox.active_threads) this.threadBoards.set(t.thread_id, t.board);
  }

  /** Records which board each thread and post is in, from results that give board slugs. */
  learn(tool: string, args: Record<string, unknown>, text: string): void {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    const num = (v: unknown) => (typeof v === "number" ? v : null);
    if (tool === "read_thread") {
      const t = json["thread"] as { thread_id?: number; board?: string } | undefined;
      if (t?.thread_id && t.board) {
        this.threadBoards.set(t.thread_id, t.board);
        for (const p of (json["posts"] as { post_id?: number }[] | undefined) ?? []) {
          if (p.post_id) this.postBoards.set(p.post_id, t.board);
        }
      }
    } else if (tool === "list_threads") {
      const slug = (json["board"] as { slug?: string } | undefined)?.slug;
      if (slug) {
        for (const t of (json["threads"] as { thread_id?: number }[] | undefined) ?? []) {
          if (t.thread_id) this.threadBoards.set(t.thread_id, slug);
        }
      }
    } else if (tool === "new_thread") {
      const slug = this.newThreadBoard(args);
      const threadId = num(json["thread_id"]);
      const postId = num(json["post_id"]);
      if (slug && threadId) this.threadBoards.set(threadId, slug);
      if (slug && postId) this.postBoards.set(postId, slug);
    } else if (tool === "reply") {
      const slug = this.threadBoards.get(Number(args["thread_id"]));
      const postId = num(json["post_id"]);
      if (slug && postId) this.postBoards.set(postId, slug);
    }
  }

  newThreadBoard(args: Record<string, unknown>): string | null {
    if (typeof args["board"] === "string" && args["board"]) return args["board"];
    if (args["fp_article_id"] !== undefined && args["fp_article_id"] !== null) return config.fritter_post.discussion_board;
    return null;
  }

  /** The runner's own rules for a write, or null if it may go ahead. */
  writeRefusal(tool: string, args: Record<string, unknown>): string | null {
    if (this.writes >= this.writeBudget) {
      return "You've already posted as much as you can this visit. Stop here; you'll be back later.";
    }
    const allowed = this.bot.writeBoards;
    if (!allowed) return null;
    const only = `You only post in: ${allowed.join(", ")}.`;
    if (tool === "reply") {
      const slug = this.threadBoards.get(Number(args["thread_id"]));
      if (!slug) return "Read that thread (read_thread) before replying to it.";
      return allowed.includes(slug) ? null : only;
    }
    if (tool === "new_thread") {
      const slug = this.newThreadBoard(args);
      return slug && allowed.includes(slug) ? null : only;
    }
    if (tool === "edit_post") {
      const slug = this.postBoards.get(Number(args["post_id"]));
      if (!slug) return "Read the thread with that post (read_thread) before editing it.";
      return allowed.includes(slug) ? null : only;
    }
    return null; // Messages and reports aren't posts in a board.
  }

  /** Runs one tool call for the model, under the runner's rules. Returns what the model sees. */
  async runTool(name: string, rawArgs: string, offered: Set<string>): Promise<string> {
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawArgs || "{}");
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      args = parsed as Record<string, unknown>;
    } catch {
      return this.record(name, rawArgs, false, "The arguments weren't a JSON object. Try again.");
    }
    if (!offered.has(name)) {
      return this.record(name, rawArgs, false, `There's no tool called ${name} available to you now.`);
    }
    if (WRITE_TOOLS.has(name)) {
      const refusal = this.writeRefusal(name, args);
      if (refusal) return this.record(name, rawArgs, false, refusal);
    }
    const res = await this.board.call(name, args);
    if (res.ok) {
      this.learn(name, args, res.text);
      if (WRITE_TOOLS.has(name)) this.writes++;
    }
    return this.record(name, JSON.stringify(args), res.ok, res.text);
  }

  private record(tool: string, args: string, ok: boolean, result: string): string {
    const n = config.runner.action_log_chars;
    this.actions.push({ tool, args: clip(args, n), ok, result: clip(result, n) });
    return result;
  }
}

function toolDefinition(t: { name: string; description: string; inputSchema: Record<string, unknown> }): ToolDefinition {
  const { $schema: _ignored, ...parameters } = t.inputSchema;
  return { type: "function", function: { name: t.name, description: t.description, parameters } };
}

function wakeHeader(bot: Bot, now: Date, budget: number): string {
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: config.site.timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(now);
  const lines = [`It's ${when} (Pacific time).`];
  lines.push(
    budget === 0
      ? "You can't post or send messages this visit; read if you like."
      : budget === 1
        ? "You can post or send a message once this visit."
        : `You can post or send messages up to ${budget} times this visit.`
  );
  if (bot.writeBoards && budget > 0) lines.push(`You only post in: ${bot.writeBoards.join(", ")}.`);
  return lines.join(" ");
}

function systemPrompt(board: BoardSession, bot: Bot): string {
  return `${board.instructions}\n\n${RUNNER_BRIEF}\n\n## Who you are\n\n${bot.personaPrompt.trim() || `You are ${bot.username}.`}`;
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// ── Tools mode ─────────────────────────────────────────────────────────────

async function toolsMode(s: WakeSession, inbox: InboxJson, header: string) {
  const offeredTools = s.board.tools.filter((t) => t.name !== "get_inbox");
  const offered = new Set(offeredTools.map((t) => t.name));
  const allTools = offeredTools.map(toolDefinition);
  const readTools = allTools.filter((t) => !WRITE_TOOLS.has(t.function.name));
  const system = systemPrompt(s.board, s.bot);
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: `${header}\n\nYour inbox since your last visit:\n${JSON.stringify(inbox)}` },
  ];
  s.messages = messages;
  let note: string | null = null;
  for (let step = 1; step <= s.bot.maxSteps; step++) {
    if (s.timedOut) {
      note = "Stopped: the wake ran out of time.";
      break;
    }
    const tools = s.writes < s.writeBudget ? allTools : readTools;
    const res = await s.complete({ messages, tools });
    messages.push({ role: "assistant", content: res.content, ...(res.toolCalls.length ? { tool_calls: res.toolCalls } : {}) });
    if (res.toolCalls.length === 0) {
      note = res.content?.trim() || null;
      break;
    }
    for (const call of res.toolCalls) {
      const text = await s.runTool(call.function.name, call.function.arguments, offered);
      messages.push({ role: "tool", tool_call_id: call.id, content: text });
    }
    if (step === s.bot.maxSteps) note = `Stopped after ${s.bot.maxSteps} model calls.`;
  }
  return {
    note,
    prefixHash: hash(system + JSON.stringify(allTools)),
    transcript: messages.slice(1),
  };
}

// ── Single-shot mode ───────────────────────────────────────────────────────

const DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["reply", "new_thread", "pm", "nothing"] },
    thread_id: { type: ["integer", "null"] },
    board: { type: ["string", "null"] },
    title: { type: ["string", "null"] },
    fp_article_id: { type: ["integer", "null"] },
    to: { type: ["string", "null"] },
    conversation_id: { type: ["integer", "null"] },
    body: { type: ["string", "null"] },
    reason: { type: ["string", "null"] },
  },
  required: ["action", "thread_id", "board", "title", "fp_article_id", "to", "conversation_id", "body", "reason"],
};

const Decision = z.object({
  action: z.enum(["reply", "new_thread", "pm", "nothing"]),
  thread_id: z.number().int().nullish(),
  board: z.string().nullish(),
  title: z.string().nullish(),
  fp_article_id: z.number().int().nullish(),
  to: z.string().nullish(),
  conversation_id: z.number().int().nullish(),
  body: z.string().nullish(),
  reason: z.string().nullish(),
});
type Decision = z.infer<typeof Decision>;

/** The first JSON object in a reply, for models that wrap it in prose or a code fence. */
export function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("There's no JSON object in the reply.");
    return JSON.parse(text.slice(start, end + 1));
  }
}

async function singleShotMode(s: WakeSession, inbox: InboxJson, header: string) {
  const system = systemPrompt(s.board, s.bot);
  const prefixHash = hash(system + JSON.stringify(DECISION_SCHEMA));
  if (s.writeBudget === 0) {
    return { note: "No posts left for today: nothing to decide.", prefixHash, transcript: [] as ChatMessage[] };
  }
  const limit = config.runner.single_shot_threads;
  const allowed = (slug: string) => !s.bot.writeBoards || s.bot.writeBoards.includes(slug);

  // Threads worth showing: where the bot was quoted or mentioned, then the busiest.
  const picks: number[] = [];
  const add = (id: number, slug: string) => {
    if (picks.length < limit && !picks.includes(id) && allowed(slug)) picks.push(id);
  };
  for (const p of [...inbox.replies, ...inbox.mentions]) add(p.thread_id, p.board);
  for (const t of [...inbox.active_threads].sort((a, b) => b.new_posts - a.new_posts)) add(t.thread_id, t.board);

  const threads: unknown[] = [];
  for (const id of picks) {
    const res = await s.board.call("read_thread", { thread_id: id });
    if (res.ok) {
      s.learn("read_thread", { thread_id: id }, res.text);
      threads.push(JSON.parse(res.text));
    }
  }
  const conversations: unknown[] = [];
  for (const pm of inbox.unread_pms.slice(0, limit)) {
    const res = await s.board.call("read_pms", { conversation_id: pm.conversation_id });
    if (res.ok) conversations.push(JSON.parse(res.text));
  }
  let article: { fp_article_id: number } | null = null;
  if (Array.isArray(inbox.new_articles) && allowed(config.fritter_post.discussion_board)) {
    const fresh = inbox.new_articles.find((a) => a.thread_id === null);
    if (fresh) {
      const res = await s.board.call("read_article", { fp_article_id: fresh.fp_article_id });
      if (res.ok) article = JSON.parse(res.text) as { fp_article_id: number };
    }
  }
  const offeredThreads = new Set(picks.filter((id) => s.threadBoards.has(id)));
  const offeredConversations = new Set(inbox.unread_pms.slice(0, limit).map((c) => c.conversation_id));

  const task = [
    header,
    `Your inbox since your last visit:\n${JSON.stringify(inbox)}`,
    threads.length ? `Threads you've just read:\n${JSON.stringify(threads)}` : "No threads to show you this time.",
    conversations.length ? `Your unread private messages:\n${JSON.stringify(conversations)}` : "",
    article ? `A new Fritter Post article with no thread yet:\n${JSON.stringify(article)}` : "",
    `Decide on one thing to do this visit, and answer with only a JSON object:
- {"action":"reply","thread_id":<one of the threads above>,"body":"…"}
- {"action":"new_thread","board":"<slug>","title":"…","body":"…"}${article ? `, or with "fp_article_id":${article.fp_article_id} to start the article's thread` : ""}
- {"action":"pm","to":"<username>","body":"…"} or {"action":"pm","conversation_id":<one above>,"body":"…"}
- {"action":"nothing","reason":"…"}
Set every other field to null. Doing nothing is a fine choice.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: task },
  ];
  s.messages = messages;

  let decision: Decision | null = null;
  let problem = "";
  for (let attempt = 1; attempt <= 2 && decision === null; attempt++) {
    if (attempt === 2) messages.push({ role: "user", content: `${problem} Answer again with only the JSON object.` });
    const res = await s.complete({ messages, jsonSchema: { name: "decision", schema: DECISION_SCHEMA } });
    messages.push({ role: "assistant", content: res.content });
    try {
      const parsed = Decision.safeParse(extractJson(res.content ?? ""));
      if (!parsed.success) throw new Error("That JSON isn't one of the decisions described.");
      decision = parsed.data;
      problem = decisionProblem(decision, offeredThreads, offeredConversations, article?.fp_article_id ?? null) ?? "";
      if (problem) decision = null;
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
    }
  }
  if (decision === null) {
    throw new Error(`The model didn't give a usable decision: ${problem}`);
  }

  let note: string;
  const body = decision.body ?? "";
  const run = (tool: string, args: Record<string, unknown>) => s.runTool(tool, JSON.stringify(args), new Set([tool]));
  switch (decision.action) {
    case "nothing":
      note = `Did nothing${decision.reason ? `: ${decision.reason}` : "."}`;
      break;
    case "reply":
      await run("reply", { thread_id: decision.thread_id, body });
      note = `Replied in thread ${decision.thread_id}.`;
      break;
    case "new_thread":
      await run("new_thread", {
        ...(decision.board ? { board: decision.board } : {}),
        title: decision.title ?? "",
        body,
        ...(decision.fp_article_id ? { fp_article_id: decision.fp_article_id } : {}),
      });
      note = `Started a thread: ${decision.title ?? ""}`;
      break;
    case "pm":
      await run(
        "send_pm",
        decision.conversation_id ? { conversation_id: decision.conversation_id, body } : { to: decision.to ?? "", body }
      );
      note = decision.conversation_id ? `Answered PM ${decision.conversation_id}.` : `Sent a PM to ${decision.to}.`;
      break;
  }
  const last = s.actions[s.actions.length - 1];
  if (decision.action !== "nothing" && last && !last.ok) note = `Tried, and was refused: ${last.result}`;
  return { note, prefixHash, transcript: messages.slice(1) };
}

function decisionProblem(
  d: Decision,
  threads: Set<number>,
  conversations: Set<number>,
  articleId: number | null
): string | null {
  const needsBody = d.action !== "nothing" && !(d.body ?? "").trim();
  if (needsBody) return "The body is empty.";
  if (d.action === "reply" && (d.thread_id == null || !threads.has(d.thread_id))) {
    return "Reply only to one of the threads shown.";
  }
  if (d.action === "new_thread") {
    if (!(d.title ?? "").trim()) return "A new thread needs a title.";
    if (d.fp_article_id != null && d.fp_article_id !== articleId) return "Only the article shown can get a thread.";
    if (!d.board && d.fp_article_id == null) return "Say which board (its slug).";
  }
  if (d.action === "pm") {
    if (d.conversation_id != null && !conversations.has(d.conversation_id)) return "Answer only a conversation shown.";
    if (d.conversation_id == null && !(d.to ?? "").trim()) return "Say who the message is to.";
  }
  return null;
}

// ── A wake ─────────────────────────────────────────────────────────────────

export async function runWake(deps: WakeDeps, bot: Bot, trigger: Trigger): Promise<WakeResult> {
  const runId = await startRun(deps.db, bot, trigger);
  const result = (outcome: Outcome, extra: Partial<WakeResult> = {}): WakeResult => ({
    outcome,
    cursor: null,
    pausedUntil: null,
    runId,
    ...extra,
  });
  const empty = { modelCalls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0, writes: 0, actions: [] };

  const token = deps.secret(bot.boardTokenRef);
  const apiKey = deps.secret(bot.apiKeyRef);
  if (!token || !apiKey) {
    const missing = [!token && bot.boardTokenRef, !apiKey && bot.apiKeyRef].filter(Boolean).join(" and ");
    await finishRun(deps.db, runId, { ...empty, outcome: "failed", error: `${missing} isn't set in the runner's environment.` });
    return result("failed");
  }

  let board: BoardSession;
  try {
    board = await deps.connectBoard(token);
  } catch (err) {
    await finishRun(deps.db, runId, { ...empty, outcome: "failed", error: `Couldn't reach the board: ${String(err)}` });
    return result("failed");
  }

  let session: WakeSession | null = null;
  let inbox: InboxJson | null = null;
  try {
    // A peek: the bot counts as online only once it actually does something.
    inbox = await callJson<InboxJson>(board, "get_inbox", {
      ...(bot.inboxCursor ? { since: bot.inboxCursor.toISOString() } : {}),
      peek: true,
    });
    const times = { inboxSince: new Date(inbox.since), inboxUntil: new Date(inbox.now) };

    if (inbox.you.status && inbox.you.status !== "active") {
      await finishRun(deps.db, runId, { ...empty, ...times, outcome: "skipped", note: `The account is ${inbox.you.status}.` });
      return result("skipped");
    }

    const waiting = earlyWakeReason(inbox, bot.inboxCursor);
    if (trigger === "schedule" && !waiting && deps.random() < bot.lurkBias) {
      // The cursor stays put: next time, the bot catches up on all of it.
      await finishRun(deps.db, runId, { ...empty, ...times, outcome: "lurked" });
      return result("lurked");
    }

    const usedToday = await writesLastDay(deps.db, bot.userId);
    const budget = Math.max(
      0,
      Math.min(
        bot.maxWritesPerWake,
        bot.postsPerDay - usedToday,
        inbox.you.writes_left.this_hour,
        inbox.you.writes_left.today
      )
    );
    const deadline = deps.now().getTime() + config.runner.wake_timeout_seconds * 1000;
    session = new WakeSession(deps, bot, board, deps.modelFor(apiKey), budget, deadline);
    session.learnFromInbox(inbox);
    const header = wakeHeader(bot, deps.now(), budget) + (waiting ? ` (You're up early: ${waiting}.)` : "");

    const out = bot.mode === "tools" ? await toolsMode(session, inbox, header) : await singleShotMode(session, inbox, header);
    await finishRun(deps.db, runId, {
      outcome: "done",
      ...times,
      modelCalls: session.modelCalls,
      ...session.usage,
      writes: session.writes,
      actions: session.actions,
      note: out.note,
      prefixHash: out.prefixHash,
      transcript: out.transcript,
    });
    return result("done", { cursor: new Date(inbox.now) });
  } catch (err) {
    const capped = err instanceof DailyCapReached;
    await finishRun(deps.db, runId, {
      ...empty,
      ...(session
        ? {
            modelCalls: session.modelCalls,
            ...session.usage,
            writes: session.writes,
            actions: session.actions,
            transcript: session.messages.length ? session.messages.slice(1) : null,
          }
        : {}),
      outcome: "failed",
      inboxSince: inbox ? new Date(inbox.since) : null,
      inboxUntil: inbox ? new Date(inbox.now) : null,
      error: capped ? `${err.message} Paused until ${err.until.toISOString()}.` : err instanceof Error ? err.message : String(err),
    });
    return result("failed", { pausedUntil: capped ? err.until : null });
  } finally {
    await board.close().catch(() => {});
  }
}
