import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { issueBotToken } from "../src/auth/bot-tokens.js";
import { parsePublicUrl } from "../src/config.js";
import { insertUser } from "../src/forum/accounts.js";
import { sendNewMessage } from "../src/forum/pms.js";
import { createThread, reply } from "../src/forum/threads.js";
import type { Viewer } from "../src/forum/types.js";
import { createMcpApp } from "../src/mcp/app.js";
import { loadPhrases, loadPraise, measure, type MetricPost } from "../src/metrics/voice.js";
import { httpBoard } from "../src/runner/board.js";
import { runDryVisits } from "../src/runner/dryvisit.js";
import { loadPatterns, measurePost } from "../src/runner/measure.js";
import type { ChatModel, ChatRequest, ChatResponse } from "../src/runner/model.js";
import { parsePersona, personaPrompt, pickSide, rollWords, sideText, SIDE_WAY_OUT } from "../src/runner/persona.js";
import { botByUsername, modelCallsLastDay, writesLastDay } from "../src/runner/store.js";
import { loadScenarios } from "../src/runner/voice.js";
import { runVoiceTest } from "../src/runner/voicetest.js";
import { runWake, type WakeDeps } from "../src/runner/wake.js";
import { ORIGIN, setup, testDatabaseUrl } from "./support.js";

// The voice plan's chunk 1: personas with a stance and sides, the side and
// length a visit is given, dry visits over a look-only connection, the voice
// test, and the quote-and-praise count. The model is scripted.

const ROOT = path.join(import.meta.dirname, "..");

const PERSONA = `You are Testbot, a plain test account.

## Stance

You never praise a line; you ask about it.

## Sides

### Chatty (weight 3, 15-50 words)
You're here for the people.

### Off-Topic (weight 1, 3-10 words)
Start something silly in Off-Topic.`;

// ── Without a database ──

function unit() {
  const p = parsePersona(PERSONA);
  assert.deepEqual(p.problems, []);
  assert.equal(p.core, "You are Testbot, a plain test account.");
  assert.equal(p.stance, "You never praise a line; you ask about it.");
  assert.deepEqual(
    p.sides.map((s) => [s.name, s.weight, s.minWords, s.maxWords, s.text]),
    [
      ["Chatty", 3, 15, 50, "You're here for the people."],
      ["Off-Topic", 1, 3, 10, "Start something silly in Off-Topic."],
    ]
  );
  const prompt = personaPrompt(PERSONA);
  assert.match(prompt, /plain test account\.\n\nYou never praise/, "core, then stance");
  assert.doesNotMatch(prompt, /Sides|here for the people|weight/, "sides stay out of the system prompt");
  assert.equal(personaPrompt("Just a core.\n\n## Something else\ntext"), "Just a core.\n\n## Something else\ntext", "other headings are core");
  assert.deepEqual(parsePersona("Core.").sides, []);

  const bad = parsePersona("Core.\n## Sides\n### Chatty (weight 3)\nText.\n### Ok (weight 1, 9-3 words)\nText.\n### Fine (weight 1, 1-2 words)\n");
  assert.equal(bad.sides.length, 0);
  assert.equal(bad.problems.length, 3, bad.problems.join(" | "));
  assert.match(bad.problems[0]!, /should read like/);
  assert.match(bad.problems[1]!, /range like/);
  assert.match(bad.problems[2]!, /has no text/);
  assert.match(parsePersona("Core.\n## Sides\nloose text\n").problems[0]!, /isn't under a side's heading/);
  assert.match(parsePersona("Core.\n## Stance\na\n## Stance\nb").problems[0]!, /two "## Stance"/);
  assert.equal(parsePersona("Core.\n## Sides\n### En dash (weight 2, 10–20 words)\nText.").sides[0]!.maxWords, 20, "an en dash works");

  assert.equal(pickSide(p.sides, () => 0)!.name, "Chatty");
  assert.equal(pickSide(p.sides, () => 0.74)!.name, "Chatty");
  assert.equal(pickSide(p.sides, () => 0.76)!.name, "Off-Topic");
  assert.equal(pickSide([], () => 0), null);
  assert.equal(rollWords({ minWords: 15, maxWords: 50 }, () => 0), 15);
  assert.equal(rollWords({ minWords: 15, maxWords: 50 }, () => 0.999), 50);
  assert.equal(rollWords({ minWords: 15, maxWords: 50 }, () => 0.5), 35, "rounded to 5");
  assert.equal(rollWords({ minWords: 3, maxWords: 4 }, () => 0.9), 4, "a range with no multiple of 5 rounds to a word");
  assert.equal(
    sideText(p.sides[0]!, 35),
    `This visit: You're here for the people.\n\nKeep each post or message this visit to about 35 words, not counting what you quote.\n\n${SIDE_WAY_OUT}`
  );

  // Measures, as the voice metrics take them.
  const patterns = loadPatterns();
  const praised = measurePost('[quote="Ann"]a reader is a friend[/quote]\n\nThat\'s the line that matters. Why though?', patterns);
  assert.equal(praised.words, 7, "quotes don't count");
  assert.equal(praised.opensWithQuote, true);
  assert.equal(praised.question, true);
  assert.deepEqual(praised.praise, ["that's the line"]);
  assert.deepEqual(measurePost("That's the line I was looking for.", patterns).praise, [], "praise without a quote doesn't count");
  assert.deepEqual(measurePost('[quote="Ann"]x y z[/quote]\nYes. And the rest.', patterns).praise, ["yes, exactly"]);

  const post = (id: number, author: string, body: string): MetricPost => ({
    id, author, isBot: author !== "John", board: "News", threadId: 1, isFirst: id === 1, at: "2026-10-12 10:00", body, removed: false,
  });
  const r = measure(
    [post(1, "John", "Start."), post(2, "Ann", '[quote="John"]Start.[/quote]\nThe sharpest thing said here.'), post(3, "Ann", "No quote, the sharpest.")],
    loadPhrases(),
    { source: "test", boards: ["News"], praise: loadPraise() }
  );
  assert.equal(r.members.find((m) => m.name === "Ann")!.quotePraise, 0.5);
  assert.equal(measure([post(2, "Ann", '[quote="John"]a[/quote]\nThe sharpest.')], loadPhrases(), { source: "t", boards: ["News"] }).allBots.quotePraise, 0, "no praise list, no count");

  // Every cast persona parses, and has a stance and sides.
  for (const name of ["mercurio", "jake", "hapax", "magpie", "captain-boday", "penny", "blackbird86", "kardashev", "sexton", "bickerstaff"]) {
    const d = parsePersona(readFileSync(path.join(ROOT, "personas", `${name}.md`), "utf-8"));
    assert.deepEqual(d.problems, [], name);
    assert.ok(d.stance && d.sides.length >= 3, name);
  }
  assert.ok(loadScenarios().some((s) => s.name === "praise") && loadScenarios().some((s) => s.name === "games"), "the archive scenarios");
}

// ── With the database ──

type Step = (req: ChatRequest) => ChatResponse;
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
const usage = { promptTokens: 100, completionTokens: 20, reasoningTokens: 0, cachedTokens: 0 };
const say = (content: string): ChatResponse => ({ content, toolCalls: [], finishReason: "stop", usage });
let callN = 0;
const use = (name: string, args: Record<string, unknown>): ChatResponse => ({
  content: null,
  toolCalls: [{ id: `call_${++callN}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  finishReason: "tool_calls",
  usage,
});
const firstText = (req: ChatRequest) => String(req.messages[1]?.content ?? "");
const systemText = (req: ChatRequest) => String(req.messages[0]?.content ?? "");

async function integration() {
  const { pool, forum, reset } = setup("voice");
  const mcp = createMcpApp({ forum, env: parsePublicUrl(ORIGIN, 0, null) });
  const DB_URL = testDatabaseUrl("voice");
  const cli = (args: string[], input?: string) => {
    const res = spawnSync(path.join(ROOT, "node_modules", ".bin", "tsx"), [path.join(ROOT, "scripts", "bot.ts"), ...args], {
      env: { ...process.env, DATABASE_URL: DB_URL },
      input,
      encoding: "utf-8",
    });
    return { code: res.status, out: res.stdout, err: res.stderr };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const one = async (sql: string, params: unknown[] = []): Promise<any> => (await pool.query(sql, params)).rows[0];

  await reset();
  const johnId = await insertUser(pool, { username: "John", password: "a-long-password", role: "admin" });
  const john: Viewer = { id: johnId, username: "John", role: "admin", status: "active", isBot: false };
  const botId = await insertUser(pool, { username: "Testbot", password: null, isBot: true });
  const bot: Viewer = { id: botId, username: "Testbot", role: "member", status: "active", isBot: true };
  const secrets: Record<string, string | undefined> = { K_TEST: "sk-own", T_TEST: await issueBotToken(pool, botId) };
  const general = (await one("SELECT id FROM boards WHERE slug = 'general'")).id as number;
  const { threadId } = await createThread(forum, john, general, "Bridges", "Discuss bridges.");

  // The persona's format is checked when it's saved.
  let c = cli(["config", "Testbot", "--model", "vendor/m", "--key-env", "K_TEST", "--token-env", "T_TEST", "--lurk", "0", "--window", "00:00-24:00", "--persona-file", "-"],
    "Core.\n## Sides\n### Chatty (weight three, 15-50 words)\nText.\n");
  assert.notEqual(c.code, 0);
  assert.match(c.err, /persona's format: .*should read like/);
  c = cli(["config", "Testbot", "--model", "vendor/m", "--key-env", "K_TEST", "--token-env", "T_TEST", "--lurk", "0", "--window", "00:00-24:00", "--persona-file", "-"], `${PERSONA}\n`);
  assert.equal(c.code, 0, c.err);

  const model = new ScriptedModel();
  const keys: string[] = [];
  let dice = 0.1;
  let now = new Date();
  const deps: WakeDeps = {
    db: pool,
    connectBoard: httpBoard("http://mcp.test/mcp", (async (url: string | URL | Request, init?: RequestInit) => mcp.fetch(new Request(url, init))) as typeof fetch),
    modelFor: (key) => {
      keys.push(key);
      return model;
    },
    secret: (name) => secrets[name],
    now: () => now,
    random: () => dice,
    sleep: async () => {},
  };

  // ── A visit gets a side and a length ──
  model.script((req) => {
    assert.match(firstText(req), /\n\nThis visit: You're here for the people\.\n\nKeep each post or message this visit to about 20 words/);
    assert.match(systemText(req), /You never praise a line/, "the stance is in the system prompt");
    assert.doesNotMatch(systemText(req), /here for the people|## Sides/, "the sides aren't");
    return say("Looked around.");
  });
  let r = await runWake(deps, (await botByUsername(pool, "Testbot"))!, "manual");
  assert.equal(r.outcome, "done");
  assert.equal(r.voice?.side.name, "Chatty");
  let run = await one("SELECT * FROM bots.runs WHERE id = $1", [r.runId]);
  assert.equal(run.side, "Chatty");
  assert.equal(run.post_words, 20);
  let st = await one("SELECT side, side_until FROM bots.state WHERE user_id = $1", [botId]);
  assert.equal(st.side, "Chatty");
  assert.ok(Math.abs(new Date(st.side_until).getTime() - (now.getTime() + 6 * 3_600_000)) < 1000, "held for side_hours");

  // Within the hours the side holds, whatever the dice say; the length is rolled again.
  dice = 0.9;
  model.script((req) => {
    assert.match(firstText(req), /This visit: You're here for the people\.\n\nKeep each post or message this visit to about 45 words/);
    return say("Again.");
  });
  r = await runWake(deps, (await botByUsername(pool, "Testbot"))!, "manual");
  assert.equal(r.voice?.side.name, "Chatty");
  assert.equal(r.voice?.words, 45);

  // Once it runs out, a new side by weight.
  now = new Date(now.getTime() + 7 * 3_600_000);
  model.script((req) => {
    assert.match(firstText(req), /This visit: Start something silly in Off-Topic\./);
    return say("Off.");
  });
  r = await runWake(deps, (await botByUsername(pool, "Testbot"))!, "manual");
  assert.equal(r.voice?.side.name, "Off-Topic");
  st = await one("SELECT side FROM bots.state WHERE user_id = $1", [botId]);
  assert.equal(st.side, "Off-Topic");

  // A persona without sides: no side line, and the persona whole.
  await pool.query("UPDATE bots.config SET persona_prompt = 'You are Testbot.' WHERE user_id = $1", [botId]);
  model.script((req) => {
    assert.doesNotMatch(firstText(req), /This visit:/);
    assert.match(systemText(req), /## Who you are\n\nYou are Testbot\./);
    return say("Plain.");
  });
  r = await runWake(deps, (await botByUsername(pool, "Testbot"))!, "manual");
  assert.equal(r.voice, null);
  assert.equal((await one("SELECT side FROM bots.runs WHERE id = $1", [r.runId])).side, null);
  await pool.query("UPDATE bots.config SET persona_prompt = $2 WHERE user_id = $1", [botId, PERSONA]);

  // ── A dry visit ──
  await reply(forum, john, threadId, "Anyone like the Forth Bridge?");
  await sendNewMessage(forum, john, "Testbot", "hi", "Got a minute?");
  const unreadBefore = await one("SELECT last_read_message_id FROM pm_participants p JOIN users u ON u.id = p.user_id WHERE u.username = 'Testbot'");
  const stateBefore = await one("SELECT inbox_cursor, side, side_until, next_wake_at FROM bots.state WHERE user_id = $1", [botId]);
  const postsBefore = (await one("SELECT COUNT(*)::int AS n FROM posts")).n;
  const seenBefore = (await one("SELECT last_seen_at FROM users WHERE id = $1", [botId])).last_seen_at;
  const writesBefore = await writesLastDay(pool, botId);
  const callsBefore = await modelCallsLastDay(pool, botId, "member");
  keys.length = 0;
  model.script(
    (req) => {
      assert.match(firstText(req), /This visit: You're here for the people\./, "the side asked for");
      assert.match(systemText(req), /A DRAFT CORE/, "the draft persona");
      assert.match(systemText(req), /A DRAFT BRIEF/, "the draft brief");
      assert.ok(!(req.tools ?? []).some((t) => t.function.name === "web_search"), "no web search");
      return use("read_thread", { thread_id: threadId });
    },
    () => use("read_pms", { conversation_id: 1 }),
    (req) => {
      assert.match(String(req.messages[req.messages.length - 1]!.content), /Got a minute/);
      return use("reply", { thread_id: threadId, body: '[quote="John"]Anyone like the Forth Bridge?[/quote]\nThat\'s the line. Red and huge.' });
    },
    (req) => {
      assert.match(String(req.messages[req.messages.length - 1]!.content), /"posted":true/, "answered as the board would");
      return use("remember", { text: "John likes bridges.", about: "John" });
    },
    () => use("send_pm", { to: "John", body: "Sure, what's up?" }),
    () => say("Replied, noted, messaged.")
  );
  await pool.query("UPDATE bots.config SET max_writes_per_wake = 3 WHERE user_id = $1", [botId]);
  const dryBot = (await botByUsername(pool, "Testbot"))!;
  r = await runWake(deps, dryBot, "manual", {
    dry: { apiKey: "sk-test", side: "chatty", persona: PERSONA.replace("You are Testbot", "A DRAFT CORE. You are Testbot"), memberBrief: "A DRAFT BRIEF." },
  });
  assert.equal(r.outcome, "done", JSON.stringify(r));
  assert.deepEqual(keys, ["sk-test"], "the test key, not the bot's own");
  assert.equal(r.cursor, null, "a dry visit doesn't move the cursor");
  assert.deepEqual(r.drafts!.map((d) => d.tool), ["reply", "remember", "send_pm"]);
  assert.equal(r.drafts![0]!.board, "general");
  run = await one("SELECT * FROM bots.runs WHERE id = $1", [r.runId]);
  assert.equal(run.kind, "dry");
  assert.equal(run.side, "Chatty");
  assert.equal((await one("SELECT COUNT(*)::int AS n FROM posts")).n, postsBefore, "nothing posted");
  assert.equal((await one("SELECT COUNT(*)::int AS n FROM bots.notes WHERE user_id = $1", [botId])).n, 0, "nothing noted");
  assert.equal((await one("SELECT COUNT(*)::int AS n FROM pm_messages")).n, 1, "nothing sent");
  assert.equal((await one("SELECT COUNT(*)::int AS n FROM read_markers WHERE user_id = $1", [botId])).n, 0, "nothing marked read");
  assert.deepEqual(await one("SELECT last_read_message_id FROM pm_participants p JOIN users u ON u.id = p.user_id WHERE u.username = 'Testbot'"), unreadBefore, "the PM is still unread");
  assert.deepEqual((await one("SELECT last_seen_at FROM users WHERE id = $1", [botId])).last_seen_at, seenBefore, "not seen");
  assert.deepEqual(await one("SELECT inbox_cursor, side, side_until, next_wake_at FROM bots.state WHERE user_id = $1", [botId]), stateBefore, "state untouched");
  assert.equal(await writesLastDay(pool, botId), writesBefore, "doesn't count against the day's writes");
  assert.equal(await modelCallsLastDay(pool, botId, "member"), callsBefore, "or the day's calls");

  // The look-only connection refuses writes itself.
  const look = await deps.connectBoard(secrets["T_TEST"]!, { lookOnly: true });
  const refused = await look.call("reply", { thread_id: threadId, body: "Sneaky." });
  assert.equal(refused.ok, false);
  assert.match(refused.text, /only looks/);
  await look.close();
  const plain = await deps.connectBoard(secrets["T_TEST"]!);
  assert.equal((await plain.call("read_thread", { thread_id: threadId })).ok, true);
  assert.equal((await one("SELECT COUNT(*)::int AS n FROM read_markers WHERE user_id = $1", [botId])).n, 1, "an ordinary connection still marks read");
  await plain.close();

  // A server that doesn't know look-only connections: the visit stops before reading anything.
  await pool.query("DELETE FROM read_markers");
  model.script(() => {
    throw new Error("no model call on a server without look-only");
  });
  const oldServer = { ...deps, connectBoard: (token: string) => deps.connectBoard(token) };
  r = await runWake(oldServer, dryBot, "manual", { dry: { apiKey: "sk-test" } });
  assert.equal(r.outcome, "failed");
  assert.match((await one("SELECT error FROM bots.runs WHERE id = $1", [r.runId])).error, /doesn't know look-only/);
  assert.equal((await one("SELECT COUNT(*)::int AS n FROM read_markers WHERE user_id = $1", [botId])).n, 0, "nothing marked read");
  model.script();

  // The dry-visit report.
  model.script(
    () => use("reply", { thread_id: threadId, body: "Short and sweet, as asked for here." }),
    () => say("Done.")
  );
  await pool.query("DELETE FROM read_markers");
  const report = await runDryVisits(
    { ...deps, log: () => {} },
    { bots: [dryBot], apiKey: "sk-test", sides: "Off-Topic", personas: new Map(), personaSource: "as set", briefSource: "as bots get it now" }
  );
  assert.match(report, /\| Testbot \| Off-Topic \| \d+ \| 1 \(7\) \|/, report);
  assert.match(report, /### reply to thread \d+ in general · 7 words/);
  assert.match(report, /Short and sweet, as asked for here\./);
  assert.match(report, /Its note: Done\./);

  // ── The voice test ──
  const asked: number[] = [];
  const fake: ChatModel = {
    async complete(req) {
      const m = /about (\d+) words/.exec(String(req.messages[1]!.content));
      if (m) asked.push(Number(m[1]));
      const n = m ? Number(m[1]) : 120;
      return say(['[quote="magpie"]a friend[/quote]', "That's the line.", ...Array(n - 3).fill("word")].join(" "));
    },
  };
  const scenarios = loadScenarios().filter((s) => s.name === "reply" || s.name === "new_thread");
  const test = await runVoiceTest(
    { chat: fake, now: () => new Date(), random: () => 0.5, sleep: async () => {}, log: () => {} },
    {
      bots: [{ name: "Testbot", model: "vendor/m", effort: "low", persona: PERSONA, current: "You are Testbot." }],
      scenarios,
      repeat: 2,
      memberBrief: "Brief.",
      briefSource: "a draft",
      personaSource: "drafts",
      control: { memberBrief: "Old brief.", briefSource: "as shipped" },
      edited: [{ name: "Testbot", text: "You are Testbot." }],
    }
  );
  assert.equal(asked.length, 8, "2 sides × 2 scenarios × 2 samples asked for a length; the control isn't");
  assert.match(test, /\| Testbot \| Chatty \| 4 \| 35 \|/);
  assert.match(test, /\| Testbot \| control \(today\) \| 4 \| - \| \d+ \|/);
  assert.match(test, /## Against the ready line/);
  assert.match(test, /\| Testbot \| 100% \(yes\) \| \d+ in 15-50 \(yes\) \| 100% vs 100% \(no\) \| no \|/, test);
  assert.match(test, /or in under 5% of them/);
  assert.match(test, /#### Chatty · asked 35 · wrote \d+/);
  assert.match(test, /## Personas edited since personas\//);

  // Only the sides asked for, with no control: praise is held to the floor alone.
  asked.length = 0;
  const some = await runVoiceTest(
    { chat: fake, now: () => new Date(), random: () => 0.5, sleep: async () => {}, log: () => {} },
    {
      bots: [{ name: "Testbot", model: "vendor/m", effort: "low", persona: PERSONA, current: "You are Testbot." }],
      scenarios,
      repeat: 1,
      memberBrief: "Brief.",
      briefSource: "a draft",
      personaSource: "drafts",
      control: null,
      sides: ["off-topic"],
    }
  );
  assert.equal(asked.length, 2, "one side × 2 scenarios");
  assert.doesNotMatch(some, /\| Testbot \| Chatty \|/);
  assert.match(some, /Only these sides: off-topic/);
  assert.match(some, /\| Testbot \| 100% \(yes\) \| - in 15-50 \(\?\) \| 100% vs - \(no\) \| \? \|/, some);
  await assert.rejects(
    runVoiceTest(
      { chat: fake, now: () => new Date(), random: () => 0.5, sleep: async () => {}, log: () => {} },
      { bots: [{ name: "Testbot", model: "vendor/m", effort: "low", persona: PERSONA, current: "" }], scenarios, repeat: 1, memberBrief: "", briefSource: "", personaSource: "", control: null, sides: ["Grumpy"] }
    ),
    /Testbot has no side called "Grumpy"\. Its sides: Chatty, Off-Topic\./
  );

  await pool.end();
}

async function main() {
  unit();
  await integration();
}

main()
  .then(() => console.log("voice: all tests passed"))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
