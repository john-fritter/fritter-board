import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { issueBotToken } from "../src/auth/bot-tokens.js";
import { config, parsePublicUrl } from "../src/config.js";
import { insertUser } from "../src/forum/accounts.js";
import { removePost, reportPost } from "../src/forum/moderation.js";
import { createThread, reply } from "../src/forum/threads.js";
import type { Viewer } from "../src/forum/types.js";
import { createMcpApp } from "../src/mcp/app.js";
import { httpBoard } from "../src/runner/board.js";
import { ModelError, type ChatModel, type ChatRequest, type ChatResponse } from "../src/runner/model.js";
import { Runner } from "../src/runner/runner.js";
import { ORIGIN, run, setup, testDatabaseUrl } from "./support.js";

// Phase 7 end to end: the moderator. The site rules as a thread the board
// knows; hot threads, new members and a member's mod history; who a moderator
// may act on; and in the runner, the role briefs, moderation rounds on their
// own key, the per-bot share of a shared key, and a capped key pausing every
// bot on it. Models are scripted.

const { pool, forum, reset, req, login } = setup("phase7");
const mcp = createMcpApp({ forum, env: parsePublicUrl(ORIGIN, 0) });
const ROOT = path.join(import.meta.dirname, "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const DB_URL = testDatabaseUrl("phase7");
const PW = "a-long-password";

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "phase7-test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://mcp.test/mcp"), {
      fetch: async (url, init) => mcp.fetch(new Request(url, init)),
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
  );
  return client;
}

type Result = { isError?: boolean; content: { type: string; text: string }[] };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = (await client.callTool({ name, arguments: args })) as Result;
  const text = res.content[0]?.text ?? "";
  assert.ok(!res.isError, `${name} failed: ${text}`);
  return JSON.parse(text);
}

async function refused(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = (await client.callTool({ name, arguments: args })) as Result;
  const text = res.content[0]?.text ?? "";
  assert.ok(res.isError, `${name} should have failed, got: ${text}`);
  return text;
}

type Step = (req: ChatRequest) => ChatResponse | Promise<ChatResponse>;

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

const usage = { promptTokens: 1000, completionTokens: 50, reasoningTokens: 0, cachedTokens: 0 };
const say = (content: string): ChatResponse => ({ content, toolCalls: [], finishReason: "stop", usage });
let callN = 0;
const use = (name: string, args: Record<string, unknown>): ChatResponse => ({
  content: null,
  toolCalls: [{ id: `call_${++callN}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  finishReason: "tool_calls",
  usage,
});
const toolNames = (req: ChatRequest) => (req.tools ?? []).map((t) => t.function.name);
const text = (req: ChatRequest, i: number) => {
  const m = req.messages[i < 0 ? req.messages.length + i : i]!;
  return "content" in m ? (m.content ?? "") : "";
};
const lastText = (req: ChatRequest) => text(req, -1);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lastJson = (req: ChatRequest): any => JSON.parse(lastText(req));
const capped = () => new ModelError("Daily limit reached", 429, "daily_rpd_limit_exceeded", 3600);

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
const secrets: Record<string, string | undefined> = { K_MEMBER: "sk-member", K_MOD: "sk-mod" };
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
  random: () => 0.5,
  sleep: async () => {},
  log: (line) => logs.push(line),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const one = async (sql: string, params: unknown[] = []): Promise<any> => (await pool.query(sql, params)).rows[0];
const state = (id: number) => one("SELECT * FROM bots.state WHERE user_id = $1", [id]);
const lastRun = (id: number, kind = "wake") =>
  one("SELECT * FROM bots.runs WHERE user_id = $1 AND kind = $2 ORDER BY id DESC LIMIT 1", [id, kind]);
const runCount = async (id: number, kind: string) =>
  (await one("SELECT COUNT(*)::int AS n FROM bots.runs WHERE user_id = $1 AND kind = $2", [id, kind])).n as number;
const setState = (id: number, sql: string) => pool.query(`UPDATE bots.state SET ${sql} WHERE user_id = $1`, [id]);
const makeDue = (id: number) => setState(id, "next_wake_at = NOW() - INTERVAL '1 minute'");
const notDue = (id: number) => setState(id, "next_wake_at = NOW() + INTERVAL '1 day'");
const noPatrol = (id: number) => setState(id, "mod_next_at = NOW() + INTERVAL '1 day'");

async function main() {
  await reset();
  const startedAt = new Date(Date.now() - 1000);
  const viewer = (id: number, username: string, role: Viewer["role"] = "member", isBot = false): Viewer => ({
    id,
    username,
    role,
    status: "active",
    isBot,
  });
  const johnId = await insertUser(pool, { username: "John", password: PW, role: "admin" });
  const john = viewer(johnId, "John", "admin");
  const danId = await insertUser(pool, { username: "Dan", password: PW });
  const dan = viewer(danId, "Dan");
  const moId = await insertUser(pool, { username: "Mo", password: PW, role: "moderator" });
  const mo = viewer(moId, "Mo", "moderator");
  const bickId = await insertUser(pool, { username: "Bickerstaff", password: null, isBot: true, role: "moderator" });
  const testbotId = await insertUser(pool, { username: "Testbot", password: null, isBot: true });
  const testbot = viewer(testbotId, "Testbot", "member", true);
  secrets["T_BICK"] = await issueBotToken(pool, bickId);
  secrets["T_TEST"] = await issueBotToken(pool, testbotId);
  const boardId = async (slug: string) => (await one("SELECT id FROM boards WHERE slug = $1", [slug])).id as number;
  const jc = await login("John", PW);
  const dc = await login("Dan", PW);
  const mc = await login("Mo", PW);

  // ── The site rules ──
  let res = await req("GET", "/rules");
  assert.equal(res.status, 404, "no rules yet");
  const RULES = "Don't be an asshole. Be interesting.";
  const { threadId: rules } = await createThread(forum, john, await boardId("site-business"), "Site Rules", RULES);
  res = await req("POST", `/t/${rules}/mod`, { cookie: dc, form: { action: "set_rules" } });
  assert.equal(res.status, 404, "members can't");
  res = await req("POST", `/t/${rules}/mod`, { cookie: mc, form: { action: "set_rules" } });
  assert.equal(res.status, 404, "nor moderators: it's the admin's");
  res = await req("GET", `/t/${rules}`, { cookie: jc });
  assert.match(res.text, /Make this the site rules/);
  res = await req("POST", `/t/${rules}/mod`, { cookie: jc, form: { action: "set_rules" } });
  assert.equal(res.status, 303);
  res = await req("GET", "/rules");
  assert.equal(res.status, 302);
  assert.equal(res.location, `/t/${rules}`, "anyone can find them");
  assert.doesNotMatch((await req("GET", `/t/${rules}`, { cookie: jc })).text, /Make this the site rules/);
  assert.match((await req("GET", "/")).text, /href="\/rules"/, "linked from every page");
  assert.match((await req("GET", "/modlog")).text, /Set the site rules to/, "and logged");

  const { threadId: backRoom, postId: backRoomFirst } = await createThread(forum, dan, await boardId("back-room"), "Back Room chatter", "Tunnels.");
  res = await req("POST", `/t/${backRoom}/mod`, { cookie: jc, form: { action: "set_rules" } });
  assert.equal(res.status, 400, "the rules can't be members-only");
  res = await req("POST", `/t/${rules}/mod`, { cookie: mc, form: { action: "move", board: "back-room", reason: "Hiding them" } });
  assert.equal(res.status, 400, "nor moved there");
  assert.match(res.text, /stay where everyone can read them/);

  // Locks and moves need a reason; the site rules promise one in the log.
  const { threadId: general, postId: danPost } = await createThread(forum, dan, await boardId("general"), "Bridges", "Bridges are great.");
  res = await req("POST", `/t/${general}/mod`, { cookie: mc, form: { action: "lock", reason: "" } });
  assert.equal(res.status, 400);
  res = await req("POST", `/t/${general}/mod`, { cookie: mc, form: { action: "move", board: "off-topic", reason: " " } });
  assert.equal(res.status, 400);
  res = await req("POST", `/t/${general}/mod`, { cookie: mc, form: { action: "sticky", reason: "" } });
  assert.equal(res.status, 303, "a sticky needs none");
  res = await req("POST", `/t/${general}/mod`, { cookie: mc, form: { action: "unsticky", reason: "" } });
  assert.equal(res.status, 303);

  // ── Over MCP ──
  const b = await connect(secrets["T_BICK"]!);
  const t = await connect(secrets["T_TEST"]!);
  const r = await call(t, "read_rules");
  assert.equal(r.thread_id, rules);
  assert.equal(r.body, RULES);
  assert.equal(r.by, "John");
  assert.ok(!(await t.listTools()).tools.some((x) => x.name === "mod_history"), "mod_history is for moderators");

  // Whom a moderator may act on: members, not the admin or other moderators.
  const { postId: johnPost } = await reply(forum, john, general, "Tunnels, surely.");
  const { postId: moPost } = await reply(forum, mo, general, "Now, now.");
  assert.match(await refused(b, "mod_remove_post", { post_id: johnPost, reason: "Test" }), /for the admin to remove/);
  assert.match(await refused(b, "mod_remove_post", { post_id: moPost, reason: "Test" }), /for the admin to remove/);
  assert.match(await refused(b, "mod_warn", { username: "John", reason: "Test" }), /admin's to warn/);
  assert.match(await refused(b, "mod_warn", { username: "mo", reason: "Test" }), /admin's to warn/);
  assert.match(await refused(b, "mod_lock", { thread_id: general }), /required|expected string/i, "a lock over MCP needs a reason too");
  await call(b, "mod_remove_post", { post_id: danPost, reason: "Personal information" });
  await removePost(forum, john, moPost, "The admin can");
  res = await req("POST", `/p/${johnPost}/moderate`, { cookie: mc, form: { action: "remove", reason: "Test" } });
  assert.equal(res.status, 403, "a human moderator is held to the same rule");

  // A member's history: what was done about them, not about threads they started.
  await req("POST", `/t/${general}/mod`, { cookie: mc, form: { action: "lock", reason: "Cooling off" } });
  await call(b, "mod_warn", { username: "Dan", reason: "Posting an address", message: "Please don't." });
  const h = await call(b, "mod_history", { username: "@dan" });
  assert.equal(h.name, "Dan");
  assert.deepEqual(
    h.entries.map((e: { action: string; by: string }) => [e.action, e.by]),
    [["warn", "Bickerstaff"], ["remove_post", "Bickerstaff"]]
  );
  assert.equal(h.entries[1].thread_id, general);
  assert.equal((await call(b, "mod_history", { username: "Testbot" })).note, "Nothing on record.");

  // Hot threads: six posts from two people within the window. In the Back Room, too.
  for (let i = 0; i < 5; i++) await reply(forum, i % 2 ? dan : john, backRoom, `Round ${i}.`);
  let inbox = await call(b, "get_inbox", { since: startedAt.toISOString(), peek: true });
  assert.deepEqual(
    inbox.hot_threads.map((x: { thread_id: number; board: string; recent_posts: number; posters: number; read_from: number }) => [
      x.thread_id, x.board, x.recent_posts, x.posters, x.read_from,
    ]),
    [[backRoom, "back-room", 6, 2, 1]]
  );
  assert.deepEqual(
    inbox.new_members.map((m: { name: string }) => m.name),
    ["John", "Dan", "Mo", "Testbot"],
    "new members, not yourself"
  );
  assert.equal(inbox.new_members[3].bot, true);
  inbox = await call(t, "get_inbox", { since: startedAt.toISOString(), peek: true });
  assert.equal(inbox.hot_threads, undefined, "hot threads are for moderators");
  assert.equal(inbox.open_reports, undefined);
  assert.equal(inbox.new_members.length, 4);

  // A suspended moderator isn't one: no hot threads, no history, no Back Room.
  await pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [bickId]);
  inbox = await call(b, "get_inbox", { since: startedAt.toISOString(), peek: true });
  assert.equal(inbox.hot_threads, undefined);
  assert.equal(inbox.open_reports, undefined);
  assert.ok(!inbox.active_threads.some((x: { board: string }) => x.board === "back-room"));
  assert.match(await refused(b, "mod_history", { username: "Dan" }), /not found|doesn.t exist/);
  assert.equal((await call(b, "read_rules")).thread_id, rules, "the rules are public");
  await pool.query("UPDATE users SET status = 'active' WHERE id = $1", [bickId]);
  await b.close();
  await t.close();

  // ── The runner: two bots on one member key; Bickerstaff also moderates ──
  let c = cli(
    ["config", "Testbot", "--model", "vendor/model-a", "--key-env", "K_MEMBER", "--token-env", "T_TEST", "--window", "00:00-24:00", "--lurk", "0"],
  );
  assert.equal(c.code, 0, c.err);
  c = cli(
    ["config", "Bickerstaff", "--model", "z-ai/glm-5.3", "--key-env", "K_MEMBER", "--token-env", "T_BICK", "--window", "00:00-24:00",
      "--lurk", "0", "--effort", "low", "--moderates", "on", "--mod-key-env", "K_MOD", "--mod-effort", "medium", "--persona-file", "-"],
    readFileSync(path.join(ROOT, "personas", "bickerstaff.md"), "utf-8")
  );
  assert.equal(c.code, 0, c.err);
  assert.match(c.out, /moderation\s+on: key K_MOD, reasoning medium, up to 8 model calls a round/);
  assert.match(c.out, /model calls\s+40 \(default\) a day/);
  assert.match(cli(["moderate", "Bickerstaff"]).err, /is paused/);
  assert.equal(cli(["resume", "Testbot"]).code, 0);
  assert.equal(cli(["resume", "Bickerstaff"]).code, 0);
  await runner.tick(); // first wakes and the first patrol scheduled
  assert.ok((await state(bickId)).mod_next_at, "a patrol is scheduled");
  assert.equal((await state(testbotId)).mod_next_at, null, "a bot that doesn't moderate has none");
  await Promise.all([notDue(testbotId), notDue(bickId), noPatrol(bickId)]);

  // An ordinary visit of a bot that moderates: the member's brief, a note, no mod tools.
  await reportPost(forum, dan, johnPost, "Rude to tunnels");
  model.script((q) => {
    const names = toolNames(q);
    assert.ok(!names.some((n) => n.startsWith("mod_")), `no mod tools on a visit: ${names.join(", ")}`);
    assert.ok(names.includes("report_post") && names.includes("read_rules"));
    const system = text(q, 0);
    assert.match(system, /## The board\n\nFritter Board is a small, text-only discussion board/);
    assert.match(system, /## You also moderate\n\nYou're also the board's moderator, but this is an ordinary visit/);
    assert.match(system, /## Who you are\n\nYour name is Bickerstaff/);
    assert.ok(system.indexOf("## The board") < system.indexOf("## You also moderate"));
    assert.doesNotMatch(lastText(q), /open_reports|hot_threads/, "reports and hot threads wait for a round");
    assert.equal(q.reasoningEffort, "low");
    return say("Read.");
  });
  await makeDue(bickId);
  await runner.tick();
  assert.equal(model.steps.length, 0);
  assert.equal((await lastRun(bickId)).outcome, "done");
  assert.deepEqual(keysUsed.splice(0), ["sk-member"]);
  assert.equal(await runCount(bickId, "moderation"), 0, "the report doesn't start a round on the visit's tick");

  // A patrol with nothing new since the last round calls no model and records nothing.
  await pool.query("UPDATE reports SET resolved_at = NOW() WHERE resolved_at IS NULL");
  await setState(bickId, "mod_cursor = NOW(), mod_next_at = NOW() - INTERVAL '1 minute'");
  await runner.tick();
  assert.equal(await runCount(bickId, "moderation"), 0);
  let s = await state(bickId);
  assert.ok(s.mod_next_at > new Date(), "the next patrol is scheduled");
  const cursor = s.mod_cursor as Date;

  // A new report brings a round forward, and the round moderates.
  await pool.query("UPDATE threads SET locked = FALSE WHERE id = $1", [general]);
  const { postId: testbotPost } = await reply(forum, testbot, general, "BUY CHEAP WATCHES");
  await reportPost(forum, dan, testbotPost, "Spam");
  const reportId = (await one("SELECT id FROM reports WHERE post_id = $1", [testbotPost])).id as number;
  await runner.pollEarlyWakes(new Date());
  s = await state(bickId);
  assert.equal(s.mod_early_trigger, "early");
  assert.ok(s.mod_early_at > new Date(), "within a few minutes");
  assert.ok(logs.some((l) => l.includes(`Bickerstaff will moderate at`) && l.includes(`a new report on post ${testbotPost}`)));
  await setState(bickId, "mod_early_at = NOW() - INTERVAL '1 second'");
  model.script(
    (q) => {
      const names = toolNames(q);
      for (const n of ["mod_warn", "mod_remove_post", "mod_history", "mod_resolve_report", "reply", "send_pm", "read_rules", "remember"]) {
        assert.ok(names.includes(n), `${n} is offered in a round`);
      }
      for (const n of ["report_post", "edit_post", "set_title", "read_pms", "get_inbox"]) assert.ok(!names.includes(n), `${n} isn't`);
      const system = text(q, 0);
      assert.match(system, /this is a moderation round, not an ordinary visit/);
      assert.match(system, /## Moderating\n\nYou're the board's moderator, and this round is for moderation only/);
      assert.doesNotMatch(system, /## You also moderate/);
      assert.match(system, /## Who you are\n\nYour name is Bickerstaff/);
      const first = lastText(q);
      assert.match(first, /This is a moderation round, for a new report on post \d+\. You can take up to 10 moderation actions, and you can post or send a message once\./);
      assert.match(first, /The site rules:\n"Site Rules" \(thread \d+\), posted by John:\nDon't be an asshole\. Be interesting\./);
      const round = JSON.parse(first.slice(first.indexOf("Since your last round:\n") + "Since your last round:\n".length));
      assert.deepEqual(round.open_reports.map((x: { report_id: number }) => x.report_id), [reportId]);
      assert.equal(new Date(round.since).getTime(), cursor.getTime(), "since the last round");
      assert.equal(q.reasoningEffort, "medium");
      return use("mod_history", { username: "Testbot" });
    },
    (q) => {
      assert.equal(lastJson(q).note, "Nothing on record.");
      return use("mod_remove_post", { post_id: testbotPost, reason: "Spam" });
    },
    () => use("mod_resolve_report", { report_id: reportId, resolution: "Removed as spam." }),
    () => use("reply", { thread_id: general, body: "Spam removed; carry on." }),
    (q) => {
      assert.ok(!toolNames(q).includes("reply"), "one post a round");
      assert.ok(toolNames(q).includes("mod_warn"), "mod tools stay");
      return say("Removed a spam post and resolved its report.");
    }
  );
  await runner.tick();
  assert.equal(model.steps.length, 0);
  let run = await lastRun(bickId, "moderation");
  assert.equal(run.outcome, "done", run.error);
  assert.equal(run.trigger, "early");
  assert.equal(run.reasoning_effort, "medium");
  assert.equal(run.writes, 1);
  assert.equal(run.note, "Removed a spam post and resolved its report.");
  assert.deepEqual(keysUsed.splice(0), ["sk-mod"], "the moderation key");
  const logged = (await pool.query("SELECT action FROM mod_actions WHERE moderator_id = $1 ORDER BY id DESC LIMIT 2", [bickId])).rows;
  assert.deepEqual(logged.map((x) => x.action), ["resolve_report", "remove_post"]);
  s = await state(bickId);
  assert.equal(s.mod_early_at, null);
  assert.ok(s.mod_cursor > cursor, "the cursor moves");
  assert.equal(await runCount(bickId, "wake"), 1, "a round isn't a visit");

  // A hot thread brings a round forward too, but not within the minimum gap.
  for (let i = 0; i < 6; i++) await reply(forum, i % 2 ? dan : john, backRoom, `Again ${i}.`);
  await runner.pollEarlyWakes(new Date());
  s = await state(bickId);
  assert.ok(logs.some((l) => l.includes('a hot thread, "Back Room chatter"')));
  const gap = run.started_at.getTime() + config.runner.moderation_min_gap_minutes * 60_000;
  assert.ok(s.mod_early_at.getTime() >= gap, "the gap holds");

  // A runaway round stops at the action limit.
  const limit = config.runner.moderation_actions_per_cycle;
  config.runner.moderation_actions_per_cycle = 1;
  assert.equal(cli(["moderate", "Bickerstaff"]).code, 0);
  assert.equal((await state(bickId)).mod_early_trigger, "manual");
  model.script(
    (q) => {
      assert.match(lastText(q), /This is a moderation round\. You can take up to 1 moderation actions/);
      return use("mod_lock", { thread_id: backRoom, reason: "Cooling off" });
    },
    () => use("mod_unlock", { thread_id: backRoom, reason: "" }),
    (q) => {
      assert.match(lastText(q), /the most one round may/);
      return say("Locked the Back Room thread.");
    }
  );
  await runner.tick();
  config.runner.moderation_actions_per_cycle = limit;
  run = await lastRun(bickId, "moderation");
  assert.equal(run.outcome, "done", run.error);
  assert.equal(run.trigger, "manual");
  assert.deepEqual(run.actions.map((a: { tool: string; ok: boolean }) => [a.tool, a.ok]), [["mod_lock", true], ["mod_unlock", false]]);
  keysUsed.splice(0);

  // ── Keys: each bot's share, and a capped key pauses everyone on it ──
  c = cli(["config", "Testbot", "--calls-per-day", "0"]);
  assert.match(c.out, /model calls\s+0 a day/);
  await makeDue(testbotId);
  await runner.tick();
  run = await lastRun(testbotId);
  assert.equal(run.outcome, "skipped");
  assert.match(run.note, /made its 0 model calls for the last 24 hours/);
  assert.equal(keysUsed.length, 0, "no model call");
  assert.ok((await state(testbotId)).next_wake_at > new Date(), "rescheduled");
  assert.equal(cli(["config", "Testbot", "--calls-per-day", "default"]).code, 0);

  // A visit's steps are cut to what's left of the day.
  await pool.query("UPDATE bots.config SET model_calls_per_day = 3, max_steps = 8 WHERE user_id = $1", [testbotId]);
  await pool.query(
    "INSERT INTO bots.runs (user_id, kind, trigger, outcome, mode, model, reasoning_effort, model_calls) VALUES ($1, 'wake', 'schedule', 'done', 'tools', 'x', 'low', 2)",
    [testbotId]
  );
  model.script(() => use("read_rules", {}), () => say("unreachable"));
  await makeDue(testbotId);
  await runner.tick();
  run = await lastRun(testbotId);
  assert.equal(run.model_calls, 1);
  assert.equal(run.note, "Stopped after 1 model calls.");
  await pool.query("UPDATE bots.config SET model_calls_per_day = NULL WHERE user_id = $1", [testbotId]);
  await pool.query("DELETE FROM bots.runs WHERE user_id = $1 AND model_calls = 2", [testbotId]);
  keysUsed.splice(0);

  // The member key hits its cap on Testbot's visit: Bickerstaff's visits pause too, not its rounds.
  model.script(() => {
    throw capped();
  });
  await makeDue(testbotId);
  await runner.tick();
  assert.equal((await lastRun(testbotId)).outcome, "failed");
  const [ts, bs] = [await state(testbotId), await state(bickId)];
  assert.ok(ts.paused_until > new Date());
  assert.equal(bs.paused_until?.getTime(), ts.paused_until.getTime(), "everyone on the key");
  assert.equal(bs.mod_paused_until, null, "the moderation key is another key");
  assert.ok(logs.some((l) => l.includes("K_MEMBER reached its daily cap: 2 bot(s)")));

  // The moderation key hits its cap: only rounds pause.
  await setState(bickId, "mod_early_at = NOW() - INTERVAL '1 second', mod_early_trigger = 'manual'");
  model.script(() => {
    throw capped();
  });
  await runner.tick();
  run = await lastRun(bickId, "moderation");
  assert.equal(run.outcome, "failed");
  assert.match(run.error, /moderation key reached its daily cap/);
  assert.ok((await state(bickId)).mod_paused_until > new Date());
  assert.equal(cli(["resume", "Bickerstaff"]).code, 0);
  s = await state(bickId);
  assert.equal(s.paused_until, null, "resuming lifts both pauses");
  assert.equal(s.mod_paused_until, null);
  assert.equal(s.mod_next_at, null, "and starts the rounds afresh");
  await pool.query("UPDATE bots.state SET paused_until = NULL");

  // Turning moderation off ends the rounds.
  assert.equal(cli(["config", "Bickerstaff", "--moderates", "off"]).code, 0);
  assert.match(cli(["moderate", "Bickerstaff"]).err, /doesn't moderate/);
  assert.equal(cli(["config", "Bickerstaff", "--moderates", "on"]).code, 0);

  // ── The briefs ──
  c = cli(["brief", "moderation"]);
  assert.equal(c.code, 0, c.err);
  assert.match(c.out, /as shipped, config\/briefs\/moderation\.md/);
  c = cli(["brief", "member", "--file", "-"], "A small board. Be yourself.\n");
  assert.equal(c.code, 0, c.err);
  assert.match(c.out, /The member brief \(version \d+, .* by cli\):\n\nA small board\. Be yourself\./);
  assert.match(cli(["brief", "nonsense"]).err, /The briefs are member, moderator_member, moderation/);
  model.script((q) => {
    assert.match(text(q, 0), /## The board\n\nA small board\. Be yourself\.\n\n## Who you are/, "no moderator's note for a member");
    return say("Fine.");
  });
  await makeDue(testbotId);
  await runner.tick();
  assert.equal(model.steps.length, 0);

  res = await req("GET", "/admin/briefs", { cookie: dc });
  assert.equal(res.status, 404, "admin only");
  res = await req("GET", "/admin/briefs", { cookie: jc });
  assert.equal(res.status, 200);
  assert.match(res.text, /A small board\. Be yourself\./);
  assert.match(res.text, /Go back to the shipped text/);
  res = await req("POST", "/admin/briefs/moderator_member", { cookie: jc, form: { body: "You moderate too. Report, don't act." } });
  assert.equal(res.status, 303);
  assert.equal((await one("SELECT created_by FROM bots.brief_versions WHERE name = 'moderator_member' ORDER BY id DESC LIMIT 1")).created_by, "John");
  res = await req("POST", "/admin/briefs/member/restore", { cookie: jc, form: {} });
  assert.equal(res.status, 303);
  assert.match((await one("SELECT body FROM bots.brief_versions WHERE name = 'member' ORDER BY id DESC LIMIT 1")).body, /^Fritter Board is a small/);
  res = await req("POST", "/admin/briefs/nonsense", { cookie: jc, form: { body: "x" } });
  assert.equal(res.status, 404);

  // The bot's admin page: moderation settings, and "Moderate now".
  res = await req("GET", "/admin/bots/Bickerstaff", { cookie: jc });
  assert.equal(res.status, 200);
  assert.match(res.text, /Moderate now/);
  assert.match(res.text, /rounds on <code>K_MOD<\/code>/);
  assert.match(res.text, /moderation \((early|manual)\)/, "rounds in the run list");
  res = await req("POST", "/admin/bots/Bickerstaff/settings", {
    cookie: jc,
    form: { ...Object.fromEntries(Object.entries(await settingsForm(bickId))), modSteps: "6", callsPerDay: "25" },
  });
  assert.equal(res.status, 303, res.text.slice(0, 300));
  const cfg = await one("SELECT mod_max_steps, model_calls_per_day, moderates FROM bots.config WHERE user_id = $1", [bickId]);
  assert.deepEqual([cfg.mod_max_steps, cfg.model_calls_per_day, cfg.moderates], [6, 25, true]);
  res = await req("POST", "/admin/bots/Bickerstaff/control", { cookie: jc, form: { action: "moderate" } });
  assert.equal(res.status, 303);
  assert.equal((await state(bickId)).mod_early_trigger, "manual");
}

/** The settings form as the admin page fills it. */
async function settingsForm(userId: number): Promise<Record<string, string>> {
  const { settingsText } = await import("../src/runner/settings.js");
  const row = await one("SELECT * FROM bots.config WHERE user_id = $1", [userId]);
  return settingsText(row) as unknown as Record<string, string>;
}

run("phase7", pool, main);
