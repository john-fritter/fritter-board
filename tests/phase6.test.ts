import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { issueBotToken } from "../src/auth/bot-tokens.js";
import { parsePublicUrl } from "../src/config.js";
import { insertUser } from "../src/forum/accounts.js";
import { createThread, reply } from "../src/forum/threads.js";
import type { Viewer } from "../src/forum/types.js";
import { createMcpApp } from "../src/mcp/app.js";
import { httpBoard } from "../src/runner/board.js";
import { compactionDue } from "../src/runner/compaction.js";
import { ModelError, type ChatModel, type ChatRequest, type ChatResponse } from "../src/runner/model.js";
import { Runner } from "../src/runner/runner.js";
import { localMinutes } from "../src/runner/schedule.js";
import { settingsText, writeStanding } from "../src/runner/settings.js";
import { botByUserId } from "../src/runner/store.js";
import { Summarizer } from "../src/runner/summaries.js";
import { ORIGIN, run, setup, testDatabaseUrl } from "./support.js";

// Phase 6 end to end: the bots' memory. Notes written with `remember` and
// found with `recall`; the notebook each wake starts with; notes on the
// people in a thread; compaction into the standing document; summaries of
// long threads, and the Back Room rule for them. The bot's model and the
// summary model are scripted.

const { pool, forum, reset, req, login } = setup("phase6");
const mcp = createMcpApp({ forum, env: parsePublicUrl(ORIGIN, 0) });
const ROOT = path.join(import.meta.dirname, "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const DB_URL = testDatabaseUrl("phase6");

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

function cli(args: string[], input?: string) {
  const res = spawnSync(TSX, [path.join(ROOT, "scripts", "bot.ts"), ...args], {
    env: { ...process.env, DATABASE_URL: DB_URL },
    input,
    encoding: "utf-8",
  });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

const model = new ScriptedModel();
const summaryModel = new ScriptedModel();
const secrets: Record<string, string | undefined> = { K_TEST: "sk-testbot", K_ASH: "sk-ash" };
const logs: string[] = [];
const summarizer = new Summarizer(summaryModel, { now: () => new Date(), sleep: async () => {} });
const runner = new Runner({
  db: pool,
  connectBoard: httpBoard("http://mcp.test/mcp", (async (url: string | URL | Request, init?: RequestInit) =>
    mcp.fetch(new Request(url, init))) as typeof fetch),
  modelFor: () => model,
  secret: (name) => secrets[name],
  now: () => new Date(),
  random: () => 0.5,
  sleep: async () => {},
  log: (line) => logs.push(line),
  summarizer,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const one = async (sql: string, params: unknown[] = []): Promise<any> => (await pool.query(sql, params)).rows[0];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const all = async (sql: string, params: unknown[] = []): Promise<any[]> => (await pool.query(sql, params)).rows;
const makeDue = (id: number) => pool.query("UPDATE bots.state SET next_wake_at = NOW() - INTERVAL '1 minute' WHERE user_id = $1", [id]);
const notDue = (id: number) => pool.query("UPDATE bots.state SET next_wake_at = NOW() + INTERVAL '1 day' WHERE user_id = $1", [id]);
const lastRun = (id: number) => one("SELECT * FROM bots.runs WHERE user_id = $1 ORDER BY id DESC LIMIT 1", [id]);
const runCount = async (id: number, kind: string) =>
  (await one("SELECT COUNT(*)::int AS n FROM bots.runs WHERE user_id = $1 AND kind = $2", [id, kind])).n as number;
const standing = (id: number) => one("SELECT * FROM bots.standing_versions WHERE user_id = $1 ORDER BY id DESC LIMIT 1", [id]);

async function main() {
  await reset();

  const johnId = await insertUser(pool, { username: "John", password: "a-long-password", role: "admin" });
  const john: Viewer = { id: johnId, username: "John", role: "admin", status: "active", isBot: false };
  const danId = await insertUser(pool, { username: "Dan", password: "a-long-password" });
  const dan: Viewer = { id: danId, username: "Dan", role: "member", status: "active", isBot: false };
  const testbotId = await insertUser(pool, { username: "Testbot", password: null, isBot: true });
  const ashId = await insertUser(pool, { username: "Ash", password: null, isBot: true });
  secrets["T_TEST"] = await issueBotToken(pool, testbotId);
  secrets["T_ASH"] = await issueBotToken(pool, ashId);
  const boardId = async (slug: string) => (await one("SELECT id FROM boards WHERE slug = $1", [slug])).id as number;
  const { threadId: backRoom } = await createThread(forum, dan, await boardId("back-room"), "Back Room chatter", "Tunnels or bridges?");
  await reply(forum, john, backRoom, "Bridges, obviously.");

  let c = cli(
    ["config", "Testbot", "--model", "vendor/model-a", "--key-env", "K_TEST", "--token-env", "T_TEST", "--boards", "back-room",
      "--every", "60-120", "--window", "00:00-24:00", "--lurk", "0", "--steps", "8", "--persona-file", "-"],
    "You are Testbot, a plain test account.\n"
  );
  assert.equal(c.code, 0, c.err);
  assert.equal(cli(["resume", "Testbot"]).code, 0);
  c = cli(["config", "Ash", "--model", "vendor/model-b", "--mode", "single_shot", "--key-env", "K_ASH", "--token-env", "T_ASH",
    "--window", "00:00-00:00", "--lurk", "0"]);
  assert.equal(c.code, 0, c.err);
  assert.equal(cli(["resume", "Ash"]).code, 0);
  await runner.tick(); // first wakes scheduled
  await notDue(ashId);

  // ── The notebook, and remember ──
  c = cli(["standing", "Testbot", "--file", "-"], "Dan likes bridges. I owe John an answer about tolls.\n");
  assert.equal(c.code, 0, c.err);
  assert.match(c.out, /Dan likes bridges/);
  assert.equal((await standing(testbotId)).source, "admin");

  model.script(
    (req) => {
      const names = toolNames(req);
      assert.deepEqual(names.slice(-2), ["remember", "recall"], "the runner's own tools, last in the list");
      assert.match(lastText(req), /Your standing notes, what you've come to think so far:\nDan likes bridges/);
      assert.match(lastText(req), /No notes from the last 7 days/);
      assert.match(text(req, 0), /You keep a private notebook/);
      return use("remember", { text: "Dan thinks tunnels are overrated.", about: "@dan" });
    },
    (req) => {
      assert.deepEqual({ ...lastJson(req), note_id: 0 }, { remembered: true, note_id: 0, about: "Dan" }, "the name as the board spells it");
      const remember = req.tools!.find((t) => t.function.name === "remember")!.function;
      assert.match(remember.description!, /a sentence or two: about 40 words, 280 characters at most/, "the limit in words, which models can judge");
      return use("remember", { text: "word ".repeat(60).trim() });
    },
    (req) => {
      assert.match(lastText(req), /Not kept: that note is 60 words \(299 characters\), and the most is about 40 words \(280 characters\)/);
      return use("remember", { text: "About a ghost.", about: "Nobody" });
    },
    (req) => {
      assert.match(lastText(req), /There's no member called Nobody/);
      return use("remember", { text: "The back room is quiet.", thread_id: backRoom });
    },
    () => use("remember", { text: "Third note." }),
    () => use("remember", { text: "Fourth note." }),
    (req) => {
      assert.match(lastText(req), /You've written 3 notes this visit/);
      return say("Took notes.");
    }
  );
  await makeDue(testbotId);
  await runner.tick();
  assert.equal(model.steps.length, 0);
  let r = await lastRun(testbotId);
  assert.equal(r.outcome, "done", r.error);
  let notes = await all("SELECT * FROM bots.notes WHERE user_id = $1 ORDER BY id", [testbotId]);
  assert.deepEqual(
    notes.map((n) => [n.body, n.about, n.thread_id, n.run_id]),
    [
      ["Dan thinks tunnels are overrated.", "Dan", null, r.id],
      ["The back room is quiet.", null, backRoom, r.id],
      ["Third note.", null, null, r.id],
    ]
  );
  assert.equal(r.writes, 0, "notes aren't board writes");
  c = cli(["notes", "Testbot", "--about", "dan"]);
  assert.equal(c.code, 0, c.err);
  assert.match(c.out, /#\d+  \d{4}-\d{2}-\d{2} · about Dan: Dan thinks tunnels are overrated\./);
  assert.doesNotMatch(c.out, /Third note/);

  // ── Notes on the people in a thread, and recall ──
  await pool.query(
    `INSERT INTO bots.notes (user_id, body, about, created_at, archived_at) VALUES
       ($1, 'Dan once argued for a ferry.', 'Dan', NOW() - INTERVAL '30 days', NOW()),
       ($1, 'John asked about tolls.', 'John', NOW() - INTERVAL '10 days', NULL)`,
    [testbotId]
  );
  // Keep the runner from compacting these until the compaction tests.
  await pool.query(
    "INSERT INTO bots.runs (user_id, kind, trigger, outcome, mode, model, reasoning_effort) VALUES ($1, 'compaction', 'schedule', 'done', 'tools', 'x', 'low')",
    [testbotId]
  );
  model.script(
    (req) => {
      assert.match(lastText(req), /- \d{4}-\d{2}-\d{2} · about Dan: Dan thinks tunnels are overrated\./, "recent notes");
      assert.match(lastText(req), /· thread \d+: The back room is quiet\./);
      assert.doesNotMatch(lastText(req), /ferry|John asked about tolls/, "only the recent window, unarchived");
      return use("read_thread", { thread_id: backRoom });
    },
    (req) => {
      const res = lastJson(req);
      assert.equal(res.posts.length, 2);
      assert.equal(res.your_notes.Dan.length, 1, "a note already shown this wake isn't repeated");
      assert.match(res.your_notes.Dan[0], /\d{4}-\d{2}-\d{2}: Dan once argued for a ferry\./, "archived notes come with the person");
      assert.match(res.your_notes.John[0], /John asked about tolls/);
      assert.equal(Object.keys(res.your_notes).length, 2);
      return use("recall", { query: "ferry" });
    },
    (req) => {
      const res = lastJson(req);
      assert.equal(res.notes.length, 1);
      assert.equal(res.notes[0].text, "Dan once argued for a ferry.");
      assert.equal(res.notes[0].folded_into_standing, true);
      return use("recall", { about: "john" });
    },
    (req) => {
      assert.deepEqual(lastJson(req).notes.map((n: { text: string }) => n.text), ["John asked about tolls."]);
      return use("recall", { query: "zeppelin" });
    },
    (req) => {
      assert.equal(lastJson(req).note, "Nothing found.");
      return say("Read and recalled.");
    }
  );
  await makeDue(testbotId);
  await runner.tick();
  r = await lastRun(testbotId);
  assert.equal(r.outcome, "done", r.error);
  assert.equal(model.steps.length, 0);

  // ── Single-shot mode ──
  await reply(forum, dan, backRoom, "What about you, @Ash?");
  model.script((req) => {
    assert.match(lastText(req), /Your notebook/);
    assert.match(lastText(req), /"remember":\[\{"text"/);
    return say(
      JSON.stringify({
        action: "nothing", thread_id: null, board: null, title: null, fp_article_id: null, to: null, conversation_id: null,
        body: null, reason: "Listening.", remember: [{ text: "y".repeat(400), about: "John" }, { text: "Z", about: "Nobody" }],
      })
    );
  });
  await makeDue(ashId);
  await runner.tick();
  r = await lastRun(ashId);
  assert.equal(r.outcome, "done", r.error);
  notes = await all("SELECT * FROM bots.notes WHERE user_id = $1", [ashId]);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].body.length, 280, "clipped, not refused");
  assert.equal(notes[0].about, "John");
  assert.deepEqual(r.actions.filter((a: { tool: string }) => a.tool === "remember").map((a: { ok: boolean }) => a.ok), [true, false]);
  await notDue(ashId);
  await pool.query("UPDATE bots.config SET active = FALSE WHERE user_id = $1", [ashId]);

  // ── Compaction ──
  await pool.query("DELETE FROM bots.runs WHERE kind = 'compaction'");
  await notDue(testbotId);
  const before = (await standing(testbotId)).id as number;
  model.script(
    (req) => {
      assert.equal(req.tools, undefined);
      assert.match(text(req, 0), /You are Testbot/);
      assert.match(text(req, 0), /fold the notes below into your standing notes/);
      assert.match(lastText(req), /Your standing notes now:\nDan likes bridges/);
      assert.match(lastText(req), /about John: John asked about tolls\./);
      assert.doesNotMatch(lastText(req), /tunnels/, "recent notes stay out");
      return say("z".repeat(7000));
    },
    (req) => {
      assert.match(lastText(req), /That's 7000 characters; the limit is 6000/);
      return say("```\nDan likes bridges. John is waiting on tolls.\n```");
    }
  );
  await runner.tick();
  assert.equal(model.steps.length, 0);
  r = await lastRun(testbotId);
  assert.equal(r.kind, "compaction");
  assert.equal(r.trigger, "schedule");
  assert.equal(r.outcome, "done", r.error);
  assert.match(r.note, /Folded 1 note/);
  assert.equal(r.model_calls, 2);
  let st = await standing(testbotId);
  assert.ok(st.id > before);
  assert.equal(st.source, "compaction");
  assert.equal(st.body, "Dan likes bridges. John is waiting on tolls.");
  assert.equal(st.run_id, r.id);
  assert.notEqual((await one("SELECT archived_at FROM bots.notes WHERE body = 'John asked about tolls.'")).archived_at, null);
  assert.equal((await one("SELECT COUNT(*)::int AS n FROM bots.notes WHERE user_id = $1 AND archived_at IS NULL", [testbotId])).n, 3);
  await runner.tick();
  assert.equal(await runCount(testbotId, "compaction"), 1, "not due again yet");
  assert.match(cli(["runs", "Testbot", "--limit", "1"]).out, /compaction schedule  done/);

  c = cli(["compact", "Testbot"]);
  assert.equal(c.code, 0, c.err);
  model.script((req) => {
    assert.match(lastText(req), /Dan thinks tunnels are overrated/, "compact now folds every note");
    return say("Everything, folded.");
  });
  await runner.tick();
  r = await lastRun(testbotId);
  assert.equal(r.trigger, "manual");
  assert.equal(r.outcome, "done", r.error);
  assert.equal((await one("SELECT COUNT(*)::int AS n FROM bots.notes WHERE user_id = $1 AND archived_at IS NULL", [testbotId])).n, 0);
  assert.equal((await one("SELECT compact_requested_at FROM bots.state WHERE user_id = $1", [testbotId])).compact_requested_at, null);
  assert.equal((await standing(testbotId)).body, "Everything, folded.");

  await pool.query("INSERT INTO bots.notes (user_id, body) VALUES ($1, 'A new thought.')", [testbotId]);
  cli(["compact", "Testbot"]);
  model.script(
    () => say(""),
    () => say("   ")
  );
  await runner.tick();
  r = await lastRun(testbotId);
  assert.equal(r.outcome, "failed");
  assert.match(r.error, /wrote no standing notes/);
  assert.equal((await standing(testbotId)).body, "Everything, folded.", "nothing saved");
  assert.equal((await one("SELECT archived_at FROM bots.notes WHERE body = 'A new thought.'")).archived_at, null, "nothing archived");
  assert.equal((await one("SELECT compact_requested_at FROM bots.state WHERE user_id = $1", [testbotId])).compact_requested_at, null);

  cli(["compact", "Testbot"]);
  model.script(async () => {
    await writeStanding(pool, testbotId, "John edited this meanwhile.", "admin", "John");
    return say("Racing the admin.");
  });
  await runner.tick();
  r = await lastRun(testbotId);
  assert.equal(r.outcome, "failed");
  assert.match(r.error, /edited while this ran/);
  assert.equal((await standing(testbotId)).body, "John edited this meanwhile.");
  assert.equal((await one("SELECT archived_at FROM bots.notes WHERE body = 'A new thought.'")).archived_at, null);

  // Scheduled compactions wait for the bot to be asleep.
  await pool.query("DELETE FROM bots.runs WHERE kind = 'compaction'");
  await pool.query("UPDATE bots.notes SET created_at = NOW() - INTERVAL '8 days' WHERE body = 'A new thought.'");
  const bot = (await botByUserId(pool, testbotId))!;
  const now = new Date();
  const m = localMinutes(now);
  const around = (from: number, to: number) => ({ ...bot.schedule, start: (m + from + 1440) % 1440, end: (m + to + 1440) % 1440 });
  assert.equal(await compactionDue({ db: pool }, { ...bot, schedule: around(-60, 60) }, now), null, "awake: not now");
  assert.equal(await compactionDue({ db: pool }, { ...bot, schedule: around(60, 120) }, now), "schedule", "asleep: now");
  assert.equal(await compactionDue({ db: pool }, bot, now), "schedule", "a bot awake all day compacts any time");
  await pool.query(
    "INSERT INTO bots.runs (user_id, kind, trigger, outcome, mode, model, reasoning_effort) VALUES ($1, 'compaction', 'schedule', 'failed', 'tools', 'x', 'low')",
    [testbotId]
  );
  assert.equal(await compactionDue({ db: pool }, bot, now), null, "a failed attempt waits compaction_retry_hours");
  assert.equal(await compactionDue({ db: pool }, { ...bot, compactRequestedAt: now }, now), "manual", "unless asked for");
  await pool.query("DELETE FROM bots.notes WHERE body = 'A new thought.'");

  // ── Summaries of long threads ──
  const { threadId: long } = await createThread(forum, dan, await boardId("back-room"), "A long talk", "Post one.");
  const addPosts = async (from: number, to: number) => {
    for (let i = from; i <= to; i++) await reply(forum, i % 2 ? dan : john, long, `Post ${i === 1 ? "one" : i}.`);
  };
  await addPosts(2, 45);
  const unread = () => pool.query("DELETE FROM read_markers WHERE user_id = $1", [testbotId]);
  const summaryRow = () => one("SELECT * FROM bots.thread_summaries WHERE thread_id = $1", [long]);

  summaryModel.script((req) => {
    assert.equal(req.model, "deepseek/deepseek-v4.1-flash");
    assert.equal(req.reasoningEffort, "default");
    assert.match(text(req, 0), /You summarize discussion threads/);
    assert.match(lastText(req), /Thread: "A long talk"/);
    assert.match(lastText(req), /Posts 1–33:\n#1 Dan, /);
    assert.doesNotMatch(lastText(req), /Post 34\./);
    return say("SUMMARY-A");
  });
  model.script(
    () => use("read_thread", { thread_id: long }),
    (req) => {
      const res = lastJson(req);
      assert.deepEqual(res.summary_of_earlier_posts, { through_post: 33, text: "SUMMARY-A" });
      assert.equal(res.posts.length, 12);
      assert.equal(res.posts[0].number, 34);
      assert.equal(res.thread.posts, 45);
      assert.match(res.note, /read_thread with from_post/);
      assert.match(res.your_notes.Dan.join(" "), /ferry/, "notes come with a summarized read too");
      return use("read_thread", { thread_id: long, from_post: 1 });
    },
    (req) => {
      const res = lastJson(req);
      assert.equal(res.summary_of_earlier_posts, undefined, "from_post reads straight through");
      assert.equal(res.posts[0].number, 1);
      return say("Caught up.");
    }
  );
  await makeDue(testbotId);
  await runner.tick();
  assert.equal(model.steps.length, 0);
  assert.equal(summaryModel.steps.length, 0);
  r = await lastRun(testbotId);
  assert.equal(r.outcome, "done", r.error);
  assert.equal(r.summary_calls, 1);
  assert.equal(r.summary_prompt_tokens, 1000);
  assert.equal(r.model_calls, 3, "the summary model's calls are counted apart");
  let row = await summaryRow();
  assert.equal(row.through_post, 33);
  const builtAt = row.built_at as Date;

  // A few posts later, the cached summary still serves: the rest fits in one read.
  await addPosts(46, 50);
  await unread();
  summaryModel.script();
  model.script(
    () => use("read_thread", { thread_id: long }),
    (req) => {
      const res = lastJson(req);
      assert.equal(res.summary_of_earlier_posts.through_post, 33);
      assert.equal(res.posts[0].number, 34);
      assert.equal(res.posts.length, 17);
      return say("Read.");
    }
  );
  await makeDue(testbotId);
  await runner.tick();
  assert.equal(model.steps.length, 0);
  assert.equal((await lastRun(testbotId)).summary_calls, 0);

  // Further on, it's extended from where it ended.
  await addPosts(51, 65);
  await unread();
  summaryModel.script((req) => {
    assert.match(lastText(req), /The summary so far, of posts 1–33:\nSUMMARY-A/);
    assert.match(lastText(req), /Newer posts 34–53:/);
    return say("SUMMARY-B");
  });
  model.script(
    () => use("read_thread", { thread_id: long }),
    (req) => {
      const res = lastJson(req);
      assert.deepEqual(res.summary_of_earlier_posts, { through_post: 53, text: "SUMMARY-B" });
      assert.equal(res.posts[0].number, 54);
      return say("Read.");
    }
  );
  await makeDue(testbotId);
  await runner.tick();
  assert.equal(summaryModel.steps.length, 0);
  row = await summaryRow();
  assert.equal(row.through_post, 53);
  assert.equal(row.built_at.getTime(), builtAt.getTime(), "extending doesn't make it new");

  // An old summary is rebuilt from the first post.
  await pool.query("UPDATE bots.thread_summaries SET built_at = NOW() - INTERVAL '8 days' WHERE thread_id = $1", [long]);
  await unread();
  summaryModel.script((req) => {
    assert.doesNotMatch(lastText(req), /summary so far/);
    assert.match(lastText(req), /Posts 1–53:/);
    return say("SUMMARY-C");
  });
  model.script(
    () => use("read_thread", { thread_id: long }),
    (req) => {
      assert.equal(lastJson(req).summary_of_earlier_posts.text, "SUMMARY-C");
      return say("Read.");
    }
  );
  await makeDue(testbotId);
  await runner.tick();
  assert.equal(summaryModel.steps.length, 0);
  assert.ok((await summaryRow()).built_at > builtAt);

  // A summary that can't be had is no reason to fail: the bot reads the thread as it is.
  await addPosts(66, 90);
  await unread();
  summaryModel.script(() => {
    throw new ModelError("NanoGPT 400: bad request", 400, null, null);
  });
  model.script(
    () => use("read_thread", { thread_id: long }),
    (req) => {
      const res = lastJson(req);
      assert.equal(res.summary_of_earlier_posts, undefined);
      assert.equal(res.posts[0].number, 1);
      return say("Read it the long way.");
    }
  );
  await makeDue(testbotId);
  await runner.tick();
  r = await lastRun(testbotId);
  assert.equal(r.outcome, "done", r.error);
  const failed = r.actions.find((a: { tool: string }) => a.tool === "summary");
  assert.ok(failed && !failed.ok && /400/.test(failed.result), "the failure is logged");

  // The Back Room rule: the cache answers only after the bot's own read succeeds.
  await pool.query("UPDATE threads SET deleted_at = NOW() WHERE id = $1", [long]);
  await unread();
  summaryModel.script();
  model.script(
    () => use("read_thread", { thread_id: long }),
    (req) => {
      assert.doesNotMatch(lastText(req), /SUMMARY/);
      assert.match(lastText(req), /doesn't exist/);
      return say("Gone.");
    }
  );
  await makeDue(testbotId);
  await runner.tick();
  assert.equal(model.steps.length, 0);
  assert.ok(await summaryRow(), "the cache is still there; the bot just can't get at it");
  await pool.query("UPDATE threads SET deleted_at = NULL WHERE id = $1", [long]);
  await pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [testbotId]);
  model.script();
  await makeDue(testbotId);
  await runner.tick();
  assert.equal((await lastRun(testbotId)).outcome, "skipped", "a suspended bot reads nothing, summaries included");
  await pool.query("UPDATE users SET status = 'active' WHERE id = $1", [testbotId]);
  await notDue(testbotId);

  // ── /admin/bots ──
  await insertUser(pool, { username: "Mod", password: "a-long-password", role: "moderator" });
  await insertUser(pool, { username: "Loner", password: null, isBot: true });
  const johnCookie = await login("John", "a-long-password");
  const danCookie = await login("Dan", "a-long-password");
  const modCookie = await login("Mod", "a-long-password");
  const cfgRow = () => one("SELECT * FROM bots.config WHERE user_id = $1", [testbotId]);
  const form = async (over: Record<string, string>) => ({ ...settingsText(await cfgRow()), ...over }) as Record<string, string>;
  const noInlineStyles = (html: string) => assert.doesNotMatch(html, /\sstyle=/, "no inline styles (CSP)");

  for (const cookie of [null, danCookie, modCookie]) {
    for (const path of ["/admin/bots", "/admin/bots/Testbot", "/admin/bots/Testbot/runs", `/admin/bots/Testbot/runs/${r.id}`,
      "/admin/bots/Testbot/standing", "/admin/bots/Testbot/notes", "/admin/bots/Testbot/changes"]) {
      assert.equal((await req("GET", path, { cookie })).status, 404, `${path} is hidden`);
    }
    for (const [path, f] of [
      ["/admin/bots/Testbot/control", { action: "pause" }],
      ["/admin/bots/Testbot/settings", await form({ lurk: "1" })],
      ["/admin/bots/Testbot/standing", { body: "Hijacked." }],
    ] as const) {
      assert.equal((await req("POST", path, { cookie, form: f })).status, 404, `${path} refuses`);
    }
  }
  assert.equal((await cfgRow()).active, true, "nothing changed");
  assert.equal((await cfgRow()).lurk_bias, 0);
  assert.notEqual((await standing(testbotId)).body, "Hijacked.");

  let res = await req("GET", "/admin", { cookie: johnCookie });
  assert.match(res.text, /href="\/admin\/bots"/);
  res = await req("GET", "/admin/bots", { cookie: johnCookie });
  assert.equal(res.status, 200);
  assert.match(res.text, /href="\/admin\/bots\/Testbot"/);
  assert.match(res.text, /href="\/admin\/bots\/Ash"/);
  assert.match(res.text, /without runner settings: Loner/);
  noInlineStyles(res.text);
  assert.equal((await req("GET", "/admin/bots/Loner", { cookie: johnCookie })).status, 404);
  assert.equal((await req("GET", "/admin/bots/Nobody", { cookie: johnCookie })).status, 404);

  res = await req("GET", "/admin/bots/testbot", { cookie: johnCookie });
  assert.equal(res.status, 200);
  assert.match(res.text, /John edited this meanwhile\./, "the standing notes");
  assert.match(res.text, /You are Testbot, a plain test account\./, "the persona");
  assert.match(res.text, /Compact notes now/);
  noInlineStyles(res.text);

  // Settings, validated like the CLI's, and logged with who changed them.
  res = await req("POST", "/admin/bots/Testbot/settings", { cookie: johnCookie, form: await form({ lurk: "2", model: "vendor/x-typed" }) });
  assert.equal(res.status, 400);
  assert.match(res.text, /Lurk is a number from 0 to 1/);
  assert.match(res.text, /value="vendor\/x-typed"/, "what was typed stays in the form");
  assert.equal((await cfgRow()).model, "vendor/model-a");
  res = await req("POST", "/admin/bots/Testbot/settings", { cookie: johnCookie, form: await form({ model: "vendor/m:online" }) });
  assert.match(res.text, /bills outside the subscription/);
  res = await req("POST", "/admin/bots/Testbot/settings", {
    cookie: johnCookie,
    form: await form({ lurk: "0.3", persona: "You are Testbot. <script>alert(1)</script>", window: "07:00-23:00" }),
  });
  assert.equal(res.status, 303, res.text.slice(0, 300));
  assert.match(res.location ?? "", /saved=settings/);
  let cfg = await cfgRow();
  assert.equal(Math.round(cfg.lurk_bias * 10), 3);
  assert.equal(cfg.window_start, "07:00:00");
  assert.equal((await one("SELECT next_wake_at FROM bots.state WHERE user_id = $1", [testbotId])).next_wake_at, null, "a new window reschedules");
  let entry = await one("SELECT * FROM bots.config_log WHERE user_id = $1 ORDER BY id DESC LIMIT 1", [testbotId]);
  assert.equal(entry.changed_by, "John");
  assert.deepEqual(Object.keys(entry.changes).sort(), ["lurk_bias", "persona_prompt", "window_end", "window_start"]);
  assert.equal(entry.changes.persona_prompt.from, "You are Testbot, a plain test account.");
  res = await req("GET", "/admin/bots/Testbot?saved=settings", { cookie: johnCookie });
  assert.match(res.text, /Settings saved\./);
  assert.match(res.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, "escaped");
  assert.doesNotMatch(res.text, /<script>/);
  res = await req("POST", "/admin/bots/Testbot/settings", { cookie: johnCookie, form: await form({}) });
  assert.match(res.location ?? "", /saved=unchanged/, "saving the same settings logs nothing");
  assert.equal((await one("SELECT COUNT(*)::int AS n FROM bots.config_log WHERE id > $1", [entry.id])).n, 0);

  res = await req("GET", "/admin/bots/Testbot/changes", { cookie: johnCookie });
  assert.equal(res.status, 200);
  assert.match(res.text, /persona_prompt/);
  noInlineStyles(res.text);
  res = await req("POST", `/admin/bots/Testbot/changes/${entry.id}/undo`, { cookie: johnCookie, form: {} });
  assert.equal(res.status, 303);
  cfg = await cfgRow();
  assert.equal(cfg.lurk_bias, 0, "undone");
  assert.equal(cfg.persona_prompt, "You are Testbot, a plain test account.");
  assert.equal(cfg.window_start, "00:00:00");
  assert.match(cli(["show", "Testbot"]).out, /Testbot: active/, "the CLI reads what the admin pages wrote");

  // Controls.
  res = await req("POST", "/admin/bots/Testbot/control", { cookie: johnCookie, form: { action: "pause" } });
  assert.equal(res.status, 303);
  assert.equal((await cfgRow()).active, false);
  entry = await one("SELECT * FROM bots.config_log WHERE user_id = $1 ORDER BY id DESC LIMIT 1", [testbotId]);
  assert.deepEqual(entry.changes, { active: { from: true, to: false } }, "pausing is logged");
  res = await req("POST", "/admin/bots/Testbot/control", { cookie: johnCookie, form: { action: "wake" } });
  assert.equal(res.status, 400);
  assert.match(res.text, /Testbot is paused: resume it first/);
  res = await req("POST", "/admin/bots/Testbot/control", { cookie: johnCookie, form: { action: "explode" } });
  assert.equal(res.status, 400);
  await req("POST", "/admin/bots/Testbot/control", { cookie: johnCookie, form: { action: "resume" } });
  await req("POST", "/admin/bots/Testbot/control", { cookie: johnCookie, form: { action: "wake" } });
  await req("POST", "/admin/bots/Testbot/control", { cookie: johnCookie, form: { action: "compact" } });
  const stRow = await one("SELECT * FROM bots.state WHERE user_id = $1", [testbotId]);
  assert.equal((await cfgRow()).active, true);
  assert.equal(stRow.early_wake_trigger, "manual");
  assert.notEqual(stRow.compact_requested_at, null);
  await pool.query("UPDATE bots.state SET early_wake_at = NULL, early_wake_trigger = NULL, compact_requested_at = NULL WHERE user_id = $1", [testbotId]);

  // Standing notes: edit, and restore an old version.
  res = await req("POST", "/admin/bots/Testbot/standing", { cookie: johnCookie, form: { body: "s".repeat(6001) } });
  assert.equal(res.status, 400);
  assert.match(res.text, /6001 characters; the limit is 6000/);
  res = await req("POST", "/admin/bots/Testbot/standing", { cookie: johnCookie, form: { body: "Dan likes bridges.\r\nJohn likes tolls." } });
  assert.equal(res.status, 303);
  st = await standing(testbotId);
  assert.deepEqual([st.body, st.source, st.created_by], ["Dan likes bridges.\nJohn likes tolls.", "admin", "John"]);
  const first = await one("SELECT * FROM bots.standing_versions WHERE user_id = $1 ORDER BY id LIMIT 1", [testbotId]);
  res = await req("GET", "/admin/bots/Testbot/standing", { cookie: johnCookie });
  assert.equal(res.status, 200);
  assert.match(res.text, /Restore this version/);
  noInlineStyles(res.text);
  res = await req("POST", `/admin/bots/Testbot/standing/${first.id}/restore`, { cookie: johnCookie, form: {} });
  assert.equal(res.status, 303);
  st = await standing(testbotId);
  assert.deepEqual([st.body, st.source], [first.body, "rollback"]);
  const ashVersion = await writeStanding(pool, ashId, "Ash's own.", "admin", "John");
  assert.equal((await req("POST", `/admin/bots/Testbot/standing/${ashVersion}/restore`, { cookie: johnCookie, form: {} })).status, 404, "another bot's version");

  // Notes.
  res = await req("GET", "/admin/bots/Testbot/notes?about=dan", { cookie: johnCookie });
  assert.equal(res.status, 200);
  assert.match(res.text, /Dan thinks tunnels are overrated/);
  assert.doesNotMatch(res.text, /Third note/);
  noInlineStyles(res.text);
  const note = await one("INSERT INTO bots.notes (user_id, body) VALUES ($1, 'Archive me.') RETURNING id", [testbotId]);
  res = await req("GET", "/admin/bots/Testbot/notes?folded=current", { cookie: johnCookie });
  assert.match(res.text, /Archive me\./);
  assert.doesNotMatch(res.text, /Third note/, "folded ones filtered out");
  res = await req("POST", `/admin/bots/Testbot/notes/${note.id}/archive`, { cookie: johnCookie, form: {} });
  assert.equal(res.status, 303);
  assert.notEqual((await one("SELECT archived_at FROM bots.notes WHERE id = $1", [note.id])).archived_at, null);
  const ashNote = (await one("SELECT id FROM bots.notes WHERE user_id = $1", [ashId])).id;
  assert.equal((await req("POST", `/admin/bots/Testbot/notes/${ashNote}/archive`, { cookie: johnCookie, form: {} })).status, 404);

  // Runs and transcripts.
  const wakeRun = await one("SELECT id FROM bots.runs WHERE user_id = $1 AND kind = 'wake' AND transcript IS NOT NULL ORDER BY id DESC LIMIT 1", [testbotId]);
  res = await req("GET", `/admin/bots/Testbot/runs/${wakeRun.id}`, { cookie: johnCookie });
  assert.equal(res.status, 200);
  assert.match(res.text, /Transcript/);
  assert.match(res.text, /→ read_thread\(/);
  noInlineStyles(res.text);
  const ashRun = (await lastRun(ashId)).id;
  assert.equal((await req("GET", `/admin/bots/Testbot/runs/${ashRun}`, { cookie: johnCookie })).status, 404, "another bot's run");
  res = await req("GET", "/admin/bots/Testbot/runs", { cookie: johnCookie });
  assert.equal(res.status, 200);
  assert.match(res.text, /compaction/);

  // Cross-site posts are refused as everywhere else.
  res = await req("POST", "/admin/bots/Testbot/control", { cookie: johnCookie, form: { action: "pause" }, origin: "https://evil.example" });
  assert.equal(res.status, 403);
  assert.equal((await cfgRow()).active, true);
}

run("phase6", pool, main);
