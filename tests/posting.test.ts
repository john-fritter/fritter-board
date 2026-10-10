import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { issueBotToken } from "../src/auth/bot-tokens.js";
import { config, parsePublicUrl } from "../src/config.js";
import { insertUser } from "../src/forum/accounts.js";
import { createThread, reply } from "../src/forum/threads.js";
import type { Viewer } from "../src/forum/types.js";
import { createMcpApp } from "../src/mcp/app.js";
import { httpBoard } from "../src/runner/board.js";
import type { ChatModel, ChatRequest, ChatResponse } from "../src/runner/model.js";
import {
  lengthLimits,
  opensWithQuote,
  ownWords,
  PostingChecks,
  repeatedRun,
  styleProblems,
  wordCount,
  type OwnPost,
  type StyleInput,
} from "../src/runner/posting.js";
import { Runner } from "../src/runner/runner.js";

// Posting mechanics (src/runner/posting.ts): the checks on a bot's post before
// it reaches the board (stock moves, worn words, the bot's own phrases,
// opening with a quote, length), the cap on posts a day in one thread, and
// what the inbox says about each thread's day. The pure checks first; then
// visits against the real MCP server, if TEST_DATABASE_URL is set.

const words = (n: number, word = "word") => Array.from({ length: n }, () => word).join(" ");
const own = (body: string, i = 0, threadId = 1): OwnPost => ({ threadId, postId: 100 + i, body, at: new Date() });
const input = (body: string, extra: Partial<StyleInput> = {}): StyleInput => ({
  body,
  kind: "reply",
  ownRecent: [],
  threadPosts: [],
  targetWords: null,
  longPostUsed: false,
  ...extra,
});

function unit() {
  // ── Own words ──
  assert.equal(
    ownWords('[quote="Ash" post=3]the room [quote]nested[/quote] went quiet[/quote]\nI’m [b]not[/b] sure.').trim(),
    "I'm  not  sure.",
    "quotes, nested ones too, and tags are left out; apostrophes made plain"
  );
  assert.equal(wordCount("one two -- three\n\nfour"), 4, "a dash isn't a word");
  assert.ok(opensWithQuote('  [quote="Ash" post=3]x[/quote] y') && opensWithQuote("[quote]x[/quote]"));
  assert.ok(!opensWithQuote("Well. [quote]x[/quote]"));
  assert.equal(
    repeatedRun("Nothing here is a record the room cannot quietly renovate away, honestly.", ["It's a record the room cannot quietly renovate away."], 6),
    "a record the room cannot quietly"
  );
  assert.equal(repeatedRun("I don't think that's what it is at all", ["I don't think that's what it is"], 6), null, "common words don't make a run");

  // ── Stock moves ──
  let p = styleProblems(input("That's the sharpest thing anyone has said, and it's load-bearing."));
  assert.equal(p.length, 1, "one line for all the stock moves");
  assert.match(p[0]!, /some of the board's stock moves: calling a line or a point "the sharpest"; "load-bearing"/);
  assert.match(styleProblems(input("Honestly, that’s the line."))[0]!, /that's the line/, "curly apostrophes too");
  assert.match(styleProblems(input("I want to push on that a bit."))[0]!, /push on/);
  assert.match(styleProblems(input("This one stays with me."))[0]!, /stays with you/);
  assert.deepEqual(styleProblems(input('[quote="Ash" post=3]the sharpest line, load-bearing[/quote]\nI disagree.')), [], "a quote isn't the poster's words");
  assert.deepEqual(styleProblems(input("The sharpest knife works.", { kind: "edit" })), [], "an edit is checked for length only");

  // ── Worn words ──
  assert.deepEqual(styleProblems(input("The room went quiet.", { threadPosts: ["the room is tense", "nothing"] })), [], "once in the thread is fine");
  p = styleProblems(input("The room went quiet.", { threadPosts: ["the room is tense", "and the room laughed", "x"] }));
  assert.match(p[0]!, /"the room" is already in 2 posts in this thread/);
  p = styleProblems(input("Everyone processed it.", { ownRecent: [own("We all processing this.")] }));
  assert.match(p[0]!, /You used "processed" in one of your recent posts/);
  assert.deepEqual(
    styleProblems(input("Everyone processed it.", { ownRecent: [...Array.from({ length: 8 }, (_, i) => own("fine", i)), own("processed", 9)] })),
    [],
    "only the last own_posts_checked count"
  );

  // ── Own phrases ──
  p = styleProblems(input("It is a record the board cannot quietly undo.", { ownRecent: [own("A record the board cannot quietly undo, again.")] }));
  assert.deepEqual(p, ['It repeats "a record the board cannot quietly" from one of your recent posts. Say it fresh, or leave it out.']);

  // ── Opening with a quote ──
  const q = (i: number) => own("[quote]x[/quote] mine", i);
  const plain = (i: number) => own("mine", i);
  assert.deepEqual(styleProblems(input("[quote]a[/quote] b", { ownRecent: [q(0), plain(1), plain(2), plain(3)] })), [], "one of four is fine");
  p = styleProblems(input("[quote]a[/quote] b", { ownRecent: [q(0), plain(1), q(2), plain(3), q(4)] }));
  assert.match(p[0]!, /opens with a quote, like 2 of your last 4 posts/);
  assert.deepEqual(styleProblems(input("b [quote]a[/quote]", { ownRecent: [q(0), q(1), q(2)] })), [], "quoting further down is fine");

  // ── Length ──
  assert.deepEqual(lengthLimits(20), { usual: 30, long: 60 });
  assert.deepEqual(styleProblems(input(words(200))), [], "no target, no length check");
  assert.deepEqual(styleProblems(input(words(55), { targetWords: 20 })), [], "the day's longer post");
  assert.match(styleProblems(input(words(61), { targetWords: 20 }))[0]!, /It's 61 words, not counting quotes\. You usually write about 20, and even a longer post of yours stops at 60/);
  assert.match(styleProblems(input(words(31), { targetWords: 20, longPostUsed: true }))[0]!, /you've had your one longer post today, so this one stops at 30/);
  assert.deepEqual(styleProblems(input(words(55), { targetWords: 20, longPostUsed: true, kind: "new_thread" })), [], "an opening post may run long");
  assert.deepEqual(styleProblems(input(`[quote]${words(100)}[/quote] ${words(10)}`, { targetWords: 20, longPostUsed: true })), [], "quotes don't count");

  // ── A visit's checks: the cap, send-backs, the inbox ──
  const now = new Date();
  const old = new Date(now.getTime() - 2 * 86_400_000);
  const checks = new PostingChecks({ targetWords: 20, threadPostsPerDay: 2 }, [
    { threadId: 7, postId: 1, body: "first", at: now },
    { threadId: 7, postId: 2, body: "older", at: old },
  ], now, 1);
  assert.equal(checks.postsToday(7), 1, "yesterday's post doesn't count");
  assert.equal(checks.capRefusal(7), null);
  checks.learnInbox({ active_threads: [{ thread_id: 7, title: "t", board: "general", new_posts: 1, posts_last_day: 12, your_posts_last_day: 2 }] } as never);
  assert.equal(checks.postsToday(7), 2, "the board's count when it knows more");
  assert.match(checks.capRefusal(7)!, /you've posted in this thread 2 times in the last day/);
  const shown = checks.annotate({ active_threads: [
    { thread_id: 7, title: "t", board: "general", new_posts: 1, posts_last_day: 12, your_posts_last_day: 2 },
    { thread_id: 8, title: "u", board: "general", new_posts: 1, posts_last_day: 1 },
  ] });
  assert.deepEqual(shown.active_threads, [
    { thread_id: 7, title: "t", board: "general", new_posts: 1, posts_last_day: 12, your_posts_last_day: 2, at_your_limit: true, busy: true },
    { thread_id: 8, title: "u", board: "general", new_posts: 1, posts_last_day: 1 },
  ]);
  let r = checks.styleCheck("reply", "the sharpest", 8);
  assert.match(r.refusal!, /^Not posted, so you can rework it:\n- It uses one of the board's stock moves/);
  assert.match(r.refusal!, /Change it and post again, or let it go\.$/);
  r = checks.styleCheck("reply", "the sharpest", 8);
  assert.equal(r.refusal, null, "send-backs used up: let through");
  assert.match(r.passed!, /stock moves/);
  assert.match(checks.header(), /at most 2 times a day/);
  assert.match(checks.header(), /about 20 words, not counting quotes\. One post a day, and a thread's opening post, can run to 60; otherwise a post over 30 words/);
  assert.doesNotMatch(new PostingChecks({ targetWords: null, threadPostsPerDay: 1 }, [], now, 1).header(), /words/, "no target, no length line");

  // Every configured pattern compiles (the config schema checks this too).
  for (const t of [...config.runner.house_tics, ...config.runner.worn_phrases]) new RegExp(t.pattern, "i");
}

// ── Visits ─────────────────────────────────────────────────────────────────

type Step = (req: ChatRequest) => ChatResponse | Promise<ChatResponse>;

class ScriptedModel implements ChatModel {
  steps: Step[] = [];
  async complete(req: ChatRequest): Promise<ChatResponse> {
    const step = this.steps.shift();
    if (!step) throw new Error("The model was called more often than scripted.");
    return step({ ...req, messages: [...req.messages] });
  }
  script(...steps: Step[]) {
    this.steps = steps;
  }
}

const usage = { promptTokens: 100, completionTokens: 10, reasoningTokens: 0, cachedTokens: 0 };
const say = (content: string): ChatResponse => ({ content, toolCalls: [], finishReason: "stop", usage });
let callN = 0;
const use = (name: string, args: Record<string, unknown>): ChatResponse => ({
  content: null,
  toolCalls: [{ id: `call_${++callN}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  finishReason: "tool_calls",
  usage,
});
const lastText = (req: ChatRequest) => {
  const m = req.messages[req.messages.length - 1]!;
  return "content" in m ? (m.content ?? "") : "";
};

async function visits() {
  if (!process.env["TEST_DATABASE_URL"]) {
    console.log("posting: visits skipped (TEST_DATABASE_URL not set)");
    return;
  }
  const { setup, testDatabaseUrl, ORIGIN } = await import("./support.js");
  const { pool, forum, reset } = setup("posting");
  const mcp = createMcpApp({ forum, env: parsePublicUrl(ORIGIN, 0, null) });
  const ROOT = path.join(import.meta.dirname, "..");
  const cli = (args: string[]) => {
    const res = spawnSync(path.join(ROOT, "node_modules", ".bin", "tsx"), [path.join(ROOT, "scripts", "bot.ts"), ...args], {
      env: { ...process.env, DATABASE_URL: testDatabaseUrl("posting") },
      encoding: "utf-8",
    });
    return { code: res.status, out: res.stdout, err: res.stderr };
  };
  const model = new ScriptedModel();
  const secrets: Record<string, string | undefined> = { K: "sk-test" };
  const runner = new Runner({
    db: pool,
    connectBoard: httpBoard("http://mcp.test/mcp", (async (url: string | URL | Request, init?: RequestInit) =>
      mcp.fetch(new Request(url, init))) as typeof fetch),
    modelFor: () => model,
    secret: (name) => secrets[name],
    now: () => new Date(),
    random: () => 0.5,
    sleep: async () => {},
    log: () => {},
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const one = async (sql: string, params: unknown[] = []): Promise<any> => (await pool.query(sql, params)).rows[0];
  const lastRun = (id: number) => one("SELECT * FROM bots.runs WHERE user_id = $1 ORDER BY id DESC LIMIT 1", [id]);
  const wake = async (id: number) => {
    await pool.query("UPDATE bots.state SET early_wake_at = NOW(), early_wake_trigger = 'manual' WHERE user_id = $1", [id]);
    await runner.tick();
    assert.equal(model.steps.length, 0, "every scripted step was used");
    const r = await lastRun(id);
    assert.equal(r.outcome, "done", r.error);
    return r;
  };
  const actions = (r: { actions: { tool: string; ok: boolean }[] }) => r.actions.map((a) => `${a.tool}:${a.ok ? "ok" : "no"}`);

  await reset();
  const danId = await insertUser(pool, { username: "Dan", password: "a-long-password" });
  const dan: Viewer = { id: danId, username: "Dan", role: "member", status: "active", isBot: false };
  const botId = await insertUser(pool, { username: "Testbot", password: null, isBot: true });
  const ashId = await insertUser(pool, { username: "Ash", password: null, isBot: true });
  secrets["T_BOT"] = await issueBotToken(pool, botId);
  secrets["T_ASH"] = await issueBotToken(pool, ashId);
  const general = (await one("SELECT id FROM boards WHERE slug = 'general'")).id as number;
  const { threadId: bridges } = await createThread(forum, dan, general, "Bridges", "Discuss bridges.");

  // ── Settings ──
  let c = cli(["config", "Testbot", "--model", "vendor/m", "--key-env", "K", "--token-env", "T_BOT", "--window", "00:00-24:00",
    "--lurk", "0", "--steps", "9", "--writes-per-wake", "3", "--posts-per-day", "20", "--words", "20"]);
  assert.equal(c.code, 0, c.err);
  assert.match(cli(["config", "Testbot", "--words", "lots"]).err, /Words a post takes a whole number/);
  assert.match(cli(["config", "Testbot", "--thread-cap", "0"]).err, /Posts a day in one thread must be at least 1/);
  c = cli(["show", "Testbot"]);
  assert.match(c.out, /posts\s+about 20 words; at most 2 \(default\) a day in one thread/);
  assert.equal(cli(["resume", "Testbot"]).code, 0);
  await runner.start();
  await runner.tick(); // a resumed bot's first tick schedules it

  // ── A visit: sent back twice, let through, then the thread's cap ──
  const ok = "Suspension bridges sway beautifully; cantilever bridges simply endure.";
  model.script(
    (req) => {
      assert.match(lastText(req), /You post in any one thread at most 2 times a day/, "the cap is in the opening message");
      assert.match(lastText(req), /Your posts usually run about 20 words/, "and the length");
      assert.match(lastText(req), /"posts_last_day":1/, "each active thread's day");
      return use("read_thread", { thread_id: bridges });
    },
    () => use("reply", { thread_id: bridges, body: "That's the sharpest framing of bridges I've seen." }),
    (req) => {
      assert.match(lastText(req), /^Not posted, so you can rework it:\n- It uses one of the board's stock moves: calling a line or a point "the sharpest"/);
      return use("reply", { thread_id: bridges, body: words(70, "bridge") });
    },
    (req) => {
      assert.match(lastText(req), /It's 70 words, not counting quotes/);
      return use("reply", { thread_id: bridges, body: "Load-bearing walls, load-bearing bridges." });
    },
    (req) => {
      assert.match(lastText(req), /"post_id"/, "no more send-backs: it went up");
      return use("reply", { thread_id: bridges, body: ok });
    },
    () => use("reply", { thread_id: bridges, body: "One more thing about bridges." }),
    (req) => {
      assert.match(lastText(req), /^Not posted: you've posted in this thread 2 times in the last day/);
      return say("Talked bridges.");
    }
  );
  let r = await wake(botId);
  assert.deepEqual(actions(r), ["read_thread:ok", "reply:no", "reply:no", "style:ok", "reply:ok", "reply:ok", "reply:no"]);
  assert.match(r.actions[3].result, /Let through, with no more send-backs this visit: It uses one of the board's stock moves: "load-bearing"/);
  assert.equal(r.writes, 2, "refusals aren't writes");
  const kept = (await pool.query("SELECT thread_id, post_id, body, run_id FROM bots.posts WHERE user_id = $1 ORDER BY id", [botId])).rows;
  assert.deepEqual(kept.map((k) => [k.thread_id, k.body, k.run_id]), [
    [bridges, "Load-bearing walls, load-bearing bridges.", r.id],
    [bridges, ok, r.id],
  ]);

  // ── The next visit: the thread at the limit, and busy ──
  for (let i = 0; i < 8; i++) await reply(forum, dan, bridges, `Bridge thought ${i}.`);
  model.script(
    (req) => {
      assert.match(lastText(req), /"posts_last_day":11,"you_posted":true,"your_posts_last_day":2,"at_your_limit":true,"busy":true/);
      return use("new_thread", { board: "general", title: "Spans", body: "Honestly, suspension bridges sway beautifully, cantilever bridges simply endure." });
    },
    (req) => {
      assert.match(lastText(req), /It repeats "suspension bridges sway beautifully cantilever bridges" from one of your recent posts/);
      return use("new_thread", { board: "general", title: "Stone", body: words(55, "stone") });
    },
    (req) => {
      assert.match(lastText(req), /"thread_id"/, "an opening post may run long");
      return use("edit_post", { post_id: kept[1].post_id, body: "Stone lasts. I'd cross stone." });
    },
    () => say("Started a thread and edited a post.")
  );
  r = await wake(botId);
  assert.deepEqual(actions(r), ["new_thread:no", "new_thread:ok", "edit_post:ok"]);
  assert.equal((await one("SELECT body FROM bots.posts WHERE post_id = $1", [kept[1].post_id])).body, "Stone lasts. I'd cross stone.", "an edit is kept");
  const stone = await one("SELECT thread_id FROM bots.posts WHERE user_id = $1 ORDER BY id DESC LIMIT 1", [botId]);
  assert.equal((await one("SELECT COUNT(*)::int AS n FROM bots.posts WHERE user_id = $1", [botId])).n, 3);
  assert.notEqual(stone.thread_id, bridges, "the new thread is kept, and counts for its cap");

  // ── Single-shot: one send-back, on the first answer ──
  c = cli(["config", "Ash", "--model", "vendor/m", "--mode", "single_shot", "--key-env", "K", "--token-env", "T_ASH",
    "--window", "00:00-24:00", "--lurk", "0", "--words", "10"]);
  assert.equal(c.code, 0, c.err);
  assert.equal(cli(["resume", "Ash"]).code, 0);
  await runner.tick();
  const long = (n: number) => JSON.stringify({ action: "reply", thread_id: bridges, board: null, title: null, fp_article_id: null, to: null, conversation_id: null, body: words(n, "ash"), reason: null, remember: null });
  model.script(
    (req) => {
      assert.match(lastText(req), /Bridges/);
      return say(long(40));
    },
    (req) => {
      assert.match(lastText(req), /It's 40 words, not counting quotes\. You usually write about 10, and even a longer post of yours stops at 30/);
      assert.match(lastText(req), /Answer again with only the JSON object\.$/);
      return say(long(35));
    }
  );
  r = await wake(ashId);
  assert.deepEqual(actions(r), ["style:ok", "reply:ok"], "the second answer is posted as written");
  assert.match(r.actions[0].result, /It's 35 words/);
  assert.equal((await one("SELECT COUNT(*)::int AS n FROM bots.posts WHERE user_id = $1", [ashId])).n, 1);

  // A capped thread isn't offered in single-shot mode.
  await pool.query("UPDATE bots.config SET thread_posts_per_day = 1 WHERE user_id = $1", [ashId]);
  await reply(forum, dan, bridges, "Ash, anything else?");
  model.script((req) => {
    assert.match(lastText(req), /"at_your_limit":true/);
    assert.match(lastText(req), /No threads to show you this time\./, "the capped thread isn't pre-read");
    return say(JSON.stringify({ action: "nothing", thread_id: null, board: null, title: null, fp_article_id: null, to: null, conversation_id: null, body: null, reason: "Said my piece.", remember: null }));
  });
  r = await wake(ashId);
  assert.equal(r.note, "Did nothing: Said my piece.");

  await pool.end();
}

async function main() {
  unit();
  await visits();
}

main()
  .then(() => console.log("posting: all tests passed"))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
