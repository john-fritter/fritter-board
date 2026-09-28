import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { issueBotToken } from "../src/auth/bot-tokens.js";
import { parsePublicUrl } from "../src/config.js";
import { insertUser } from "../src/forum/accounts.js";
import { sendNewMessage } from "../src/forum/pms.js";
import { createThread, reply } from "../src/forum/threads.js";
import type { Viewer } from "../src/forum/types.js";
import { createMcpApp } from "../src/mcp/app.js";
import { httpBoard } from "../src/runner/board.js";
import { ModelError, type ChatModel, type ChatRequest, type ChatResponse } from "../src/runner/model.js";
import { Runner } from "../src/runner/runner.js";
import { pruneTranscripts } from "../src/runner/store.js";
import { createPaperSchema, FP_ORIGIN, ORIGIN, run, setup, testDatabaseUrl } from "./support.js";

// Phase 5 end to end: the bot runner. Bots configured with the CLI, woken on
// schedule, early by John's PMs and @mentions only, or by hand; tools and
// single-shot modes against the real MCP server; the runner's own rules
// (writes per wake and per day, the boards a bot writes in, lurking); NanoGPT's
// daily cap and passing failures; and the run log. The model is scripted.

const { pool, forum, reset } = setup("phase5", { fp: true });
const mcp = createMcpApp({ forum, env: parsePublicUrl(ORIGIN, 0, FP_ORIGIN) });
const ROOT = path.join(import.meta.dirname, "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const DB_URL = testDatabaseUrl("phase5");

type Step = (req: ChatRequest) => ChatResponse | Promise<ChatResponse>;

/** A model that plays back scripted steps and remembers what it was asked. */
class ScriptedModel implements ChatModel {
  steps: Step[] = [];
  requests: ChatRequest[] = [];
  async complete(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push({ ...req, messages: [...req.messages] });
    const step = this.steps.shift();
    if (!step) throw new Error("The model was called more often than scripted.");
    return step(req);
  }
  script(...steps: Step[]) {
    this.steps = steps;
    this.requests = [];
  }
}

const usage = { promptTokens: 1000, completionTokens: 50, reasoningTokens: 10, cachedTokens: 400 };
const say = (content: string): ChatResponse => ({ content, toolCalls: [], finishReason: "stop", usage });
let callN = 0;
const use = (name: string, args: Record<string, unknown>): ChatResponse => ({
  content: null,
  toolCalls: [{ id: `call_${++callN}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  finishReason: "tool_calls",
  usage,
});
const toolNames = (req: ChatRequest) => (req.tools ?? []).map((t) => t.function.name);
const lastMessage = (req: ChatRequest) => req.messages[req.messages.length - 1]!;
const lastText = (req: ChatRequest) => {
  const m = lastMessage(req);
  return "content" in m ? (m.content ?? "") : "";
};

/** The bot CLI, as Gizmo runs it, against the test database. */
function cli(args: string[], input?: string) {
  const res = spawnSync(TSX, [path.join(ROOT, "scripts", "bot.ts"), ...args], {
    env: { ...process.env, DATABASE_URL: DB_URL },
    input,
    encoding: "utf-8",
  });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

const model = new ScriptedModel();
const keysUsed: string[] = [];
const secrets: Record<string, string | undefined> = { K_TEST: "sk-testbot", K_ASH: "sk-ash" };
let dice = 0.5;
const logs: string[] = [];
const runner = new Runner({
  db: pool,
  connectBoard: httpBoard("http://mcp.test/mcp", (async (url: string | URL | Request, init?: RequestInit) =>
    mcp.fetch(new Request(url, init))) as typeof fetch),
  modelFor: (key) => {
    keysUsed.push(key);
    return model;
  },
  secret: (name) => secrets[name],
  now: () => new Date(),
  random: () => dice,
  sleep: async () => {},
  log: (line) => logs.push(line),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const one = async (sql: string, params: unknown[] = []): Promise<any> => (await pool.query(sql, params)).rows[0];
const makeDue = (id: number) => pool.query("UPDATE bots.state SET next_wake_at = NOW() - INTERVAL '1 minute' WHERE user_id = $1", [id]);
const lastRun = (id: number) => one("SELECT * FROM bots.runs WHERE user_id = $1 ORDER BY id DESC LIMIT 1", [id]);
const runCount = async (id: number) => (await one("SELECT COUNT(*)::int AS n FROM bots.runs WHERE user_id = $1", [id])).n as number;
const state = (id: number) => one("SELECT * FROM bots.state WHERE user_id = $1", [id]);
const setConfig = (id: number, sql: string, params: unknown[] = []) =>
  pool.query(`UPDATE bots.config SET ${sql} WHERE user_id = $1`, [id, ...params]);

async function main() {
  await reset();
  await createPaperSchema(pool);

  const johnId = await insertUser(pool, { username: "John", password: "a-long-password", role: "admin" });
  const john: Viewer = { id: johnId, username: "John", role: "admin", status: "active", isBot: false };
  const danId = await insertUser(pool, { username: "Dan", password: "a-long-password" });
  const dan: Viewer = { id: danId, username: "Dan", role: "member", status: "active", isBot: false };
  const testbotId = await insertUser(pool, { username: "Testbot", password: null, isBot: true });
  const ashId = await insertUser(pool, { username: "Ash", password: null, isBot: true });
  secrets["T_TEST"] = await issueBotToken(pool, testbotId);
  secrets["T_ASH"] = await issueBotToken(pool, ashId);
  const boardId = async (slug: string) => (await one("SELECT id FROM boards WHERE slug = $1", [slug])).id as number;
  const { threadId: backRoom } = await createThread(forum, dan, await boardId("back-room"), "Back Room chatter", "Anyone around?");
  const { threadId: general } = await createThread(forum, dan, await boardId("general"), "Bridges", "Discuss bridges.");

  // ── Configuring bots with the CLI ──
  let c = cli(["config", "Testbot", "--model", "vendor/m:online", "--key-env", "K_TEST", "--token-env", "T_TEST"]);
  assert.notEqual(c.code, 0);
  assert.match(c.err, /bills outside the subscription/, "paid suffixes are refused");
  c = cli(["config", "John", "--model", "vendor/m"]);
  assert.match(c.err, /isn't a bot/);
  c = cli(["config", "Testbot", "--model", "vendor/model-a"]);
  assert.match(c.err, /need --key-env/, "a new bot needs its secrets named");
  c = cli(
    ["config", "Testbot", "--model", "vendor/model-a", "--key-env", "K_TEST", "--token-env", "T_TEST", "--boards", "back-room",
      "--every", "60-120", "--window", "00:00-24:00", "--lurk", "0", "--steps", "4", "--persona-file", "-"],
    "You are Testbot, a plain test account. Keep posts short.\n"
  );
  assert.equal(c.code, 0, c.err);
  assert.match(c.out, /Testbot: paused/);
  assert.match(c.out, /writes in\s+back-room/);
  assert.match(c.out, /isn't being woken yet/);
  let cfg = await one("SELECT * FROM bots.config WHERE user_id = $1", [testbotId]);
  assert.equal(cfg.persona_prompt, "You are Testbot, a plain test account. Keep posts short.");
  assert.deepEqual(cfg.write_boards, ["back-room"]);
  assert.equal(cfg.window_start, "00:00:00");
  assert.equal(cfg.window_end, "00:00:00", "24:00 is midnight: all day");
  assert.equal(cfg.active, false);
  assert.match(cli(["config", "Testbot", "--lurk", "2"]).err, /from 0 to 1/);
  assert.match(cli(["config", "Testbot", "--window", "8am-noon"]).err, /like 08:00-24:00/);
  assert.match(cli(["config", "Testbot", "--key-env", "not a var"]).err, /environment variable name/);
  c = cli(["resume", "Testbot"]);
  assert.equal(c.code, 0, c.err);
  assert.equal((await one("SELECT active FROM bots.config WHERE user_id = $1", [testbotId])).active, true);
  c = cli(["config", "Ash", "--model", "vendor/model-b", "--mode", "single_shot", "--key-env", "K_ASH", "--token-env", "T_ASH",
    "--window", "00:00-00:00", "--lurk", "0", "--posts-per-day", "3"]);
  assert.equal(c.code, 0, c.err);
  assert.equal(cli(["resume", "Ash"]).code, 0);
  assert.match(cli(["show", "Ash"]).out, /single_shot/);
  assert.equal(cli(["config", "Ash", "--effort", "default"]).code, 0, "default: send no reasoning_effort");
  assert.match(cli(["show", "Ash"]).out, /reasoning default/);
  assert.match(cli(["config", "Ash", "--effort", "extreme"]).err, /--effort is one of default, none/);

  // ── Starting up ──
  await pool.query("INSERT INTO bots.runs (user_id, trigger, mode, model, reasoning_effort) VALUES ($1, 'schedule', 'tools', 'x', 'low')", [testbotId]);
  await runner.start();
  assert.equal((await lastRun(testbotId)).outcome, "failed", "a run left open by a stopped runner is closed");
  await pool.query("DELETE FROM bots.runs");

  await runner.tick();
  assert.equal(await runCount(testbotId), 0, "no wake on the first tick");
  const firstWake = (await state(testbotId)).next_wake_at as Date;
  assert.ok(firstWake > new Date(Date.now() - 60_000) && firstWake < new Date(Date.now() + 121 * 60_000), "first wake within the interval");
  assert.equal((await one("SELECT last_seen_at FROM users WHERE id = $1", [testbotId])).last_seen_at, null, "the early-wake peek isn't being seen");

  // ── A wake in tools mode ──
  model.script(
    (req) => {
      assert.ok(!toolNames(req).includes("get_inbox"), "the runner reads the inbox itself");
      assert.ok(toolNames(req).includes("reply") && toolNames(req).includes("read_thread"));
      assert.ok(!toolNames(req).some((t) => t.startsWith("mod_")), "members aren't offered moderation");
      const system = req.messages[0]!;
      assert.equal(system.role, "system");
      assert.match(String(system.content), /BBCode/, "the server's instructions");
      assert.match(String(system.content), /You are Testbot, a plain test account/, "the persona");
      assert.match(String(system.content), /no get_inbox to call/, "the inbox comes with the visit");
      assert.match(lastText(req), /You can post or send a message once this visit/);
      assert.match(lastText(req), /You only post in: back-room/);
      assert.match(lastText(req), /Back Room chatter/, "the inbox");
      assert.equal(req.model, "vendor/model-a");
      assert.equal(req.reasoningEffort, "low");
      return use("read_thread", { thread_id: backRoom });
    },
    (req) => {
      assert.match(lastText(req), /Anyone around\?/, "the tool's result");
      return use("reply", { thread_id: backRoom, body: "Testing, one two." });
    },
    (req) => {
      assert.ok(!toolNames(req).includes("reply") && !toolNames(req).includes("send_pm"), "writes are withdrawn once used");
      assert.ok(toolNames(req).includes("read_thread"));
      return say("Read the back room and said hello.");
    }
  );
  await makeDue(testbotId);
  await runner.tick();
  assert.equal(model.steps.length, 0);
  let r = await lastRun(testbotId);
  assert.equal(r.outcome, "done", r.error);
  assert.equal(r.trigger, "schedule");
  assert.equal(r.model_calls, 3);
  assert.equal(r.prompt_tokens, 3000);
  assert.equal(r.cached_tokens, 1200);
  assert.equal(r.writes, 1);
  assert.equal(r.note, "Read the back room and said hello.");
  assert.deepEqual(r.actions.map((a: { tool: string; ok: boolean }) => [a.tool, a.ok]), [["read_thread", true], ["reply", true]]);
  assert.equal(r.transcript.length, 6, "user, then three model turns and two tool results");
  assert.equal(r.transcript[0].role, "user", "without the fixed prefix");
  assert.ok(r.prefix_hash);
  assert.deepEqual(keysUsed, ["sk-testbot"], "the bot's own key");
  const posted = await one("SELECT p.body, t.id AS thread_id FROM posts p JOIN threads t ON t.id = p.thread_id WHERE p.author_id = $1", [testbotId]);
  assert.deepEqual(posted, { body: "Testing, one two.", thread_id: backRoom });
  let st = await state(testbotId);
  assert.equal(st.inbox_cursor.getTime(), r.inbox_until.getTime(), "the cursor moves to the inbox's now");
  assert.ok(st.next_wake_at > new Date(Date.now() + 59 * 60_000), "next wake an interval away");
  assert.notEqual((await one("SELECT last_seen_at FROM users WHERE id = $1", [testbotId])).last_seen_at, null, "a real wake is being seen");

  // ── The runner's rules: boards and steps ──
  model.script(
    () => use("reply", { thread_id: general, body: "Bridges!" }),
    (req) => {
      assert.match(lastText(req), /Read that thread \(read_thread\) before replying/);
      return use("read_thread", { thread_id: general });
    },
    () => use("reply", { thread_id: general, body: "Bridges!" }),
    (req) => {
      assert.match(lastText(req), /You only post in: back-room/);
      return use("new_thread", { board: "general", title: "Tunnels", body: "Also good." });
    }
  );
  await makeDue(testbotId);
  await runner.tick();
  r = await lastRun(testbotId);
  assert.equal(r.outcome, "done", r.error);
  assert.equal(r.model_calls, 4, "max_steps");
  assert.equal(r.note, "Stopped after 4 model calls.");
  assert.equal(r.writes, 0);
  assert.equal(r.actions[3].result, "You only post in: back-room.");
  assert.equal((await one("SELECT COUNT(*)::int AS n FROM posts WHERE author_id = $1", [testbotId])).n, 1, "nothing posted outside the Back Room");

  // ── Lurking ──
  await setConfig(testbotId, "lurk_bias = 1");
  const cursorBefore = (await state(testbotId)).inbox_cursor as Date;
  model.script();
  await makeDue(testbotId);
  await runner.tick();
  r = await lastRun(testbotId);
  assert.equal(r.outcome, "lurked");
  assert.equal(r.model_calls, 0, "no model call");
  assert.equal((await state(testbotId)).inbox_cursor.getTime(), cursorBefore.getTime(), "the cursor waits, so nothing is missed");

  // ── Early wake: John's PMs and @mentions, nobody else's, nothing else ──
  await pool.query("UPDATE users SET last_seen_at = NULL WHERE id = $1", [testbotId]);
  const testbotPost = (await one("SELECT id FROM posts WHERE author_id = $1", [testbotId])).id as number;
  await reply(forum, john, backRoom, `[quote="Testbot" post=${testbotPost}]Testing[/quote]\nNoted.`);
  await reply(forum, dan, backRoom, "What do you make of it, @Testbot?");
  await runner.pollEarlyWakes(new Date());
  assert.equal((await state(testbotId)).early_wake_at, null, "a quote from John, or an @mention from Dan, doesn't");
  assert.equal((await one("SELECT last_seen_at FROM users WHERE id = $1", [testbotId])).last_seen_at, null, "peeking isn't being seen");
  await reply(forum, john, backRoom, "@testbot what do you think?");
  const polledAt = new Date();
  await runner.pollEarlyWakes(polledAt);
  st = await state(testbotId);
  assert.equal(st.early_wake_trigger, "early");
  assert.ok(st.early_wake_at >= new Date(polledAt.getTime() + 60_000 - 1000) && st.early_wake_at <= new Date(polledAt.getTime() + 5 * 60_000 + 1000), "in one to five minutes");
  assert.ok(logs.some((l) => /an @mention from John/.test(l)));

  model.script((req) => {
    assert.match(lastText(req), /You're up early: an @mention from John/);
    return say("Answered later.");
  });
  await pool.query("UPDATE bots.state SET early_wake_at = NOW() - INTERVAL '1 second' WHERE user_id = $1", [testbotId]);
  await runner.tick();
  r = await lastRun(testbotId);
  assert.equal(r.trigger, "early");
  assert.equal(r.outcome, "done", "an early wake never lurks");
  st = await state(testbotId);
  assert.equal(st.early_wake_at, null);
  assert.ok(st.inbox_cursor > cursorBefore);

  await sendNewMessage(forum, john, "Testbot", "", "Are you there?");
  await runner.pollEarlyWakes(new Date());
  assert.equal((await state(testbotId)).early_wake_trigger, "early", "a PM from John");
  await pool.query("UPDATE bots.state SET early_wake_at = NULL, early_wake_trigger = NULL WHERE user_id = $1", [testbotId]);
  await pool.query(
    `INSERT INTO bots.runs (user_id, trigger, outcome, mode, model, reasoning_effort)
     SELECT $1, 'early', 'done', 'tools', 'x', 'low' FROM generate_series(1, 5)`,
    [testbotId]
  );
  await reply(forum, john, backRoom, "@Testbot again?");
  await runner.pollEarlyWakes(new Date());
  assert.equal((await state(testbotId)).early_wake_at, null, "at most early_wakes_per_day");
  await pool.query("DELETE FROM bots.runs WHERE model = 'x'");

  // ── Waking by hand ──
  model.script(() => say("Here."));
  c = cli(["wake", "Testbot"]);
  assert.equal(c.code, 0, c.err);
  await runner.tick();
  r = await lastRun(testbotId);
  assert.equal(r.trigger, "manual");
  assert.equal(r.outcome, "done", "a manual wake doesn't lurk either");
  await setConfig(testbotId, "lurk_bias = 0");

  // ── Pacing: posts per day, and the MCP server's cap ──
  await setConfig(testbotId, "posts_per_day = 1");
  model.script((req) => {
    assert.ok(!toolNames(req).includes("reply"), "no writes left today");
    assert.match(lastText(req), /can't post or send messages this visit/);
    return say("Just reading.");
  });
  await makeDue(testbotId);
  await runner.tick();
  assert.equal((await lastRun(testbotId)).outcome, "done");
  await setConfig(testbotId, "posts_per_day = 10");
  await pool.query("INSERT INTO bot_limits (user_id, writes_per_hour) VALUES ($1, 0)", [testbotId]);
  model.script((req) => {
    assert.ok(!toolNames(req).includes("reply"), "nor past the MCP server's cap");
    return say("Just reading.");
  });
  await makeDue(testbotId);
  await runner.tick();
  await pool.query("DELETE FROM bot_limits");

  // ── Failures ──
  model.script(
    () => {
      throw new ModelError("NanoGPT 503: upstream", 503, null, null);
    },
    () => say("Fine now.")
  );
  await makeDue(testbotId);
  await runner.tick();
  r = await lastRun(testbotId);
  assert.equal(r.outcome, "done", "a passing failure is retried once");
  assert.equal(r.model_calls, 2);

  model.script(() => {
    throw new ModelError("NanoGPT 429: Daily request limit exceeded", 429, "daily_rpd_limit_exceeded", 3600);
  });
  const cursorBeforeCap = (await state(testbotId)).inbox_cursor as Date;
  await makeDue(testbotId);
  await runner.tick();
  r = await lastRun(testbotId);
  assert.equal(r.outcome, "failed");
  assert.match(r.error, /daily cap/);
  st = await state(testbotId);
  assert.ok(st.paused_until > new Date(Date.now() + 59 * 60_000), "paused until the cap resets");
  assert.equal(st.inbox_cursor.getTime(), cursorBeforeCap.getTime(), "a failed wake leaves the cursor");
  const runsBefore = await runCount(testbotId);
  await makeDue(testbotId);
  await runner.tick();
  assert.equal(await runCount(testbotId), runsBefore, "a paused bot isn't woken");
  assert.equal(cli(["resume", "Testbot"]).code, 0);
  assert.equal((await state(testbotId)).paused_until, null, "resuming lifts the pause");

  model.script(() => {
    throw new Error("The model was never meant to be called.");
  });
  await pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [testbotId]);
  await makeDue(testbotId);
  await runner.tick();
  r = await lastRun(testbotId);
  assert.equal(r.outcome, "skipped");
  assert.match(r.note, /suspended/);
  await pool.query("UPDATE users SET status = 'active' WHERE id = $1", [testbotId]);

  const token = secrets["T_TEST"];
  secrets["T_TEST"] = undefined;
  await makeDue(testbotId);
  await runner.tick();
  r = await lastRun(testbotId);
  assert.equal(r.outcome, "failed");
  assert.match(r.error, /T_TEST isn't set/);
  secrets["T_TEST"] = token;
  await pool.query("UPDATE bots.config SET active = FALSE WHERE user_id = $1", [testbotId]);

  // ── Single-shot mode ──
  await reply(forum, dan, general, "What about you, @Ash?");
  await pool.query(
    `INSERT INTO published.articles (id, published_on, ref, rank, tier, headline, body, source_count, published_at)
     VALUES (301, '2026-09-27', 'C3', 1, 'feature', 'Bridge tolls return', 'The county brought back bridge tolls.', 0, NOW())`
  );

  keysUsed.length = 0;
  model.script(
    (req) => {
      assert.equal(req.tools, undefined, "no tools in single-shot mode");
      assert.equal(req.jsonSchema?.name, "decision");
      assert.match(lastText(req), /Threads you've just read/);
      assert.match(lastText(req), /What about you, @Ash\?/, "threads pre-read");
      assert.match(lastText(req), /A new Fritter Post article with no thread yet/);
      assert.match(lastText(req), /Bridge tolls return/);
      return say(JSON.stringify({ action: "reply", thread_id: 999, board: null, title: null, fp_article_id: null, to: null, conversation_id: null, body: "Hi", reason: null }));
    },
    (req) => {
      assert.match(lastText(req), /Reply only to one of the threads shown/, "an invalid decision gets one retry");
      return say('```json\n{"action":"reply","thread_id":' + general + ',"board":null,"title":null,"fp_article_id":null,"to":null,"conversation_id":null,"body":"Bridges are underrated.","reason":null}\n```');
    }
  );
  await makeDue(ashId);
  await runner.tick();
  assert.equal(model.steps.length, 0);
  r = await lastRun(ashId);
  assert.equal(r.outcome, "done", r.error);
  assert.equal(r.mode, "single_shot");
  assert.equal(r.model_calls, 2);
  assert.equal(r.writes, 1);
  assert.equal(r.note, `Replied in thread ${general}.`);
  assert.deepEqual(keysUsed, ["sk-ash"]);
  assert.equal((await one("SELECT body FROM posts WHERE author_id = $1", [ashId])).body, "Bridges are underrated.");

  model.script(() => say('{"action":"nothing","thread_id":null,"board":null,"title":null,"fp_article_id":null,"to":null,"conversation_id":null,"body":null,"reason":"Nothing new."}'));
  await makeDue(ashId);
  await runner.tick();
  r = await lastRun(ashId);
  assert.equal(r.note, "Did nothing: Nothing new.");
  assert.equal(r.writes, 0);

  model.script(
    () => say("I think I'll reply."),
    () => say("Still no JSON.")
  );
  await makeDue(ashId);
  await runner.tick();
  r = await lastRun(ashId);
  assert.equal(r.outcome, "failed");
  assert.match(r.error, /didn't give a usable decision/);
  assert.equal(r.transcript.length, 4, "a failed wake keeps its transcript");

  // ── The run log ──
  c = cli(["runs", "Ash"]);
  assert.equal(c.code, 0, c.err);
  assert.match(c.out, /single_shot|done/);
  assert.match(c.out, /Replied in thread/);
  const runId = (await lastRun(ashId)).id as number;
  c = cli(["runs", "Ash", "--run", String(runId)]);
  assert.match(c.out, /"transcript"/);
  await pool.query("UPDATE bots.runs SET started_at = NOW() - INTERVAL '40 days' WHERE id = $1", [runId]);
  assert.equal(await pruneTranscripts(pool), 1);
  assert.equal((await one("SELECT transcript FROM bots.runs WHERE id = $1", [runId])).transcript, null, "old transcripts are cleared");
  assert.equal((await one("SELECT outcome FROM bots.runs WHERE id = $1", [runId])).outcome, "failed", "the rest of the record stays");
  assert.match(cli(["pause", "Ash"]).out, /won't be woken/);
  cfg = await one("SELECT active FROM bots.config WHERE user_id = $1", [ashId]);
  assert.equal(cfg.active, false);
}

run("phase5", pool, main);
