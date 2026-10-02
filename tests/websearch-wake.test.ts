import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { issueBotToken } from "../src/auth/bot-tokens.js";
import { parsePublicUrl } from "../src/config.js";
import { config } from "../src/config.js";
import { insertUser } from "../src/forum/accounts.js";
import { createMcpApp } from "../src/mcp/app.js";
import { defaultBriefs } from "../src/runner/briefs.js";
import { httpBoard } from "../src/runner/board.js";
import type { ChatModel, ChatRequest, ChatResponse } from "../src/runner/model.js";
import { Runner } from "../src/runner/runner.js";
import { WEB_SEARCH_BRIEF } from "../src/runner/wake.js";
import { SearchError, WebSearch, type SearchBackend } from "../src/runner/websearch.js";
import { ORIGIN, run, setup, testDatabaseUrl } from "./support.js";

// The bots' web search, end to end through a visit: the tool and its brief
// on a tools-mode visit, the summary the bot gets (never a URL), the
// fallback service, every search kept in bots.searches with its pages, the
// caps per visit, per bot and for the board, no search for a single-shot
// bot, and the admin's run page. The services and both models are scripted.

const { pool, forum, reset, req, login } = setup("websearch-wake");
const mcp = createMcpApp({ forum, env: parsePublicUrl(ORIGIN, 0) });
const ROOT = path.join(import.meta.dirname, "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const DB_URL = testDatabaseUrl("websearch-wake");

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
const lastText = (req: ChatRequest) => {
  const m = req.messages[req.messages.length - 1]!;
  return "content" in m ? (m.content ?? "") : "";
};
const system = (req: ChatRequest) => req.messages[0]!.content ?? "";

function cli(args: string[], input?: string) {
  const res = spawnSync(TSX, [path.join(ROOT, "scripts", "bot.ts"), ...args], { env: { ...process.env, DATABASE_URL: DB_URL }, input, encoding: "utf-8" });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

// Exa is out of credit; LangSearch answers.
const searched: string[] = [];
const exa: SearchBackend = {
  service: "exa",
  async search(q) {
    searched.push(`exa ${q}`);
    throw new SearchError("exa 402: Insufficient credits", 402);
  },
};
const langsearch: SearchBackend = {
  service: "langsearch",
  async search(q, o) {
    searched.push(`langsearch ${q} ${o.recency ?? "any"}`);
    return {
      hits: [{ title: `About ${q}`, url: `https://news.example/${encodeURIComponent(q)}`, site: "news.example", published: "2026-09-30", crawled: true, text: `What the page says about ${q}.` }],
      costDollars: null,
    };
  },
};
const research = new ScriptedModel();
const webSearch = new WebSearch([exa, langsearch], research, { now: () => new Date() });

const model = new ScriptedModel();
const secrets: Record<string, string | undefined> = { K_TEST: "sk-testbot", K_ASH: "sk-ash" };
const runner = new Runner({
  db: pool,
  connectBoard: httpBoard("http://mcp.test/mcp", (async (url: string | URL | Request, init?: RequestInit) => mcp.fetch(new Request(url, init))) as typeof fetch),
  modelFor: () => model,
  secret: (name) => secrets[name],
  now: () => new Date(),
  random: () => 0.5,
  sleep: async () => {},
  log: () => {},
  webSearch,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const one = async (sql: string, params: unknown[] = []): Promise<any> => (await pool.query(sql, params)).rows[0];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const all = async (sql: string, params: unknown[] = []): Promise<any[]> => (await pool.query(sql, params)).rows;
const makeDue = (id: number) => pool.query("UPDATE bots.state SET next_wake_at = NOW() - INTERVAL '1 minute' WHERE user_id = $1", [id]);
const notDue = (id: number) => pool.query("UPDATE bots.state SET next_wake_at = NOW() + INTERVAL '1 day' WHERE user_id = $1", [id]);
const lastRun = (id: number) => one("SELECT * FROM bots.runs WHERE user_id = $1 ORDER BY id DESC LIMIT 1", [id]);
/** Searches made earlier today, as rows. */
const pastSearches = (userId: number, n: number) =>
  pool.query(
    `INSERT INTO bots.searches (user_id, query, outcome, created_at)
     SELECT $1, 'earlier', 'ok', NOW() - INTERVAL '1 hour' FROM generate_series(1, $2)`,
    [userId, n]
  );

async function main() {
  await reset();

  const johnId = await insertUser(pool, { username: "John", password: "a-long-password", role: "admin" });
  void johnId;
  const testbotId = await insertUser(pool, { username: "Testbot", password: null, isBot: true });
  const ashId = await insertUser(pool, { username: "Ash", password: null, isBot: true });
  secrets["T_TEST"] = await issueBotToken(pool, testbotId);
  secrets["T_ASH"] = await issueBotToken(pool, ashId);

  let c = cli(
    ["config", "Testbot", "--model", "vendor/model-a", "--key-env", "K_TEST", "--token-env", "T_TEST", "--boards", "back-room",
      "--window", "00:00-24:00", "--lurk", "0", "--steps", "8", "--persona-file", "-"],
    "You are Testbot, a plain test account.\n"
  );
  assert.equal(c.code, 0, c.err);
  assert.equal(cli(["resume", "Testbot"]).code, 0);
  c = cli(["config", "Ash", "--model", "vendor/model-b", "--mode", "single_shot", "--key-env", "K_ASH", "--token-env", "T_ASH", "--window", "00:00-00:00", "--lurk", "0"]);
  assert.equal(c.code, 0, c.err);
  assert.equal(cli(["resume", "Ash"]).code, 0);
  await runner.tick(); // first wakes scheduled
  await notDue(ashId);

  // ── The shipped member brief: no links, and where web news may come from ──
  const member = defaultBriefs().member;
  assert.match(member, /Don't post links\./);
  assert.match(member, /in a Fritter Post article or in a web search/);
  assert.doesNotMatch(member, /can't browse/);

  // ── A visit with web_search ──
  const max = config.runner.web_searches_per_wake;
  assert.equal(max, 2, "this test is written for two searches a visit");
  research.script(
    (r) => {
      assert.equal(r.model, config.runner.web_search_models[0]!.model, "Hy3 first");
      assert.match(r.messages[1]!.content ?? "", /^The search: "fed rates" \(results from the last month\)/);
      assert.match(r.messages[1]!.content ?? "", /which may be when the page was seen rather than published/, "LangSearch's dates, labelled");
      return say("Wait, let me think about this");
    },
    (r) => {
      assert.equal(r.model, config.runner.web_search_models[1]!.model, "then V4 Pro, after a summary with problems");
      return say("The Fed raised rates to 3.75%–4% (news.example, 2026-09-30).");
    },
    () => say("Spain beat Argentina 1–0 (news.example, 2026-09-30).")
  );
  model.script(
    (r) => {
      assert.ok(toolNames(r).includes("web_search"), "offered on a tools-mode visit");
      const tool = r.tools!.find((t) => t.function.name === "web_search")!;
      assert.match(tool.function.description ?? "", /At most 2 searches this visit\./);
      assert.equal(toolNames(r).at(-1), "web_search", "after the board's tools and the notebook");
      assert.ok(system(r).includes(WEB_SEARCH_BRIEF), "and the runner's brief says how to use it");
      assert.match(system(r), /Don't post links\./);
      return use("web_search", { query: "fed rates", recent: "month" });
    },
    (r) => {
      const got = JSON.parse(lastText(r));
      assert.deepEqual(got, { search: "fed rates", summary: "The Fed raised rates to 3.75%–4% (news.example, 2026-09-30).", searches_left_this_visit: 1 });
      return use("web_search", { query: "   " });
    },
    (r) => {
      assert.equal(lastText(r), "Say what to look up.", "an empty search doesn't count");
      return use("web_search", { query: "world cup final", recent: "decade" });
    },
    (r) => {
      assert.match(lastText(r), /"recent" is one of day, week, month, year/);
      return use("web_search", { query: "world cup final" });
    },
    (r) => {
      assert.equal(JSON.parse(lastText(r)).searches_left_this_visit, 0);
      assert.ok(!lastText(r).includes("https://"), "never a URL");
      return use("web_search", { query: "one too many" });
    },
    (r) => {
      assert.match(lastText(r), /used the web searches you have for this visit/);
      return say("Looked up the Fed and the World Cup.");
    }
  );
  await makeDue(testbotId);
  await runner.tick();
  let r = await lastRun(testbotId);
  assert.equal(r.outcome, "done", r.error);
  assert.equal(model.steps.length, 0);
  assert.equal(research.steps.length, 0);
  assert.deepEqual(searched, ["exa fed rates", "langsearch fed rates month", "exa world cup final", "langsearch world cup final any"], "Exa first, LangSearch when it fails");
  assert.equal(r.model_calls, 6, "the bot's own calls only");
  assert.deepEqual(
    r.actions.filter((a: { tool: string }) => a.tool === "web_search").map((a: { ok: boolean }) => a.ok),
    [true, false, false, true, false],
    "every web_search is in the run's actions"
  );

  const rows = await all("SELECT * FROM bots.searches WHERE user_id = $1 ORDER BY id", [testbotId]);
  assert.equal(rows.length, 2, "only searches that reached a service are kept");
  assert.equal(rows[0].run_id, r.id);
  assert.equal(rows[0].query, "fed rates");
  assert.equal(rows[0].recency, "month");
  assert.equal(rows[0].service, "langsearch");
  assert.equal(rows[0].research_model, config.runner.web_search_models[1]!.model);
  assert.equal(rows[0].outcome, "ok");
  assert.deepEqual(rows[0].results, [{ title: "About fed rates", url: "https://news.example/fed%20rates", site: "news.example", published: "2026-09-30" }], "the URLs, for John");
  assert.match(rows[0].error, /^exa 402: Insufficient credits \| tencent\/hy3: thinking aloud; doesn't end cleanly$/);
  assert.equal(rows[1].recency, null);

  // The admin's run page shows them, with the links the bot never saw.
  const johnCookie = await login("John", "a-long-password");
  const page = await req("GET", `/admin/bots/Testbot/runs/${r.id}`, { cookie: johnCookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /Web searches/);
  assert.match(page.text, /“fed rates” \(last month\)/);
  assert.match(page.text, /href="https:\/\/news\.example\/fed%20rates" rel="noreferrer nofollow"/);
  assert.match(page.text, /The Fed raised rates to 3\.75%–4%/);
  assert.match(page.text, /Along the way: exa 402: Insufficient credits/);
  assert.doesNotMatch(page.text, /\sstyle=/, "no inline styles (CSP)");

  // ── The caps ──
  const visit = async (check: Step) => {
    model.script(check);
    await makeDue(testbotId);
    await runner.tick();
    const run = await lastRun(testbotId);
    assert.equal(run.outcome, "done", run.error);
  };
  const noSearch: Step = (req) => {
    assert.ok(!toolNames(req).includes("web_search"), "not offered");
    assert.ok(!system(req).includes(WEB_SEARCH_BRIEF), "and not mentioned");
    return say("Nothing to do.");
  };

  // The bot's day: it has made 2; 4 more make its daily cap.
  await pastSearches(testbotId, config.runner.web_searches_per_bot_per_day - 3);
  await visit((req) => {
    assert.match(req.tools!.find((t) => t.function.name === "web_search")!.function.description ?? "", /One search this visit\./, "one left today");
    return say("Nothing to do.");
  });
  await pastSearches(testbotId, 1);
  await visit(noSearch);

  // The board's day: other bots' searches count too.
  await pool.query("DELETE FROM bots.searches");
  await pastSearches(ashId, config.runner.web_searches_per_day);
  await visit(noSearch);
  await pool.query("DELETE FROM bots.searches");

  // ── A single-shot bot doesn't search ──
  model.script((req) => {
    assert.ok(!system(req).includes(WEB_SEARCH_BRIEF));
    assert.equal(req.tools, undefined);
    return say(
      JSON.stringify({ action: "nothing", thread_id: null, board: null, title: null, fp_article_id: null, to: null, conversation_id: null, body: null, reason: "Quiet.", remember: null })
    );
  });
  await notDue(testbotId);
  await makeDue(ashId);
  await runner.tick();
  r = await lastRun(ashId);
  assert.equal(r.outcome, "done", r.error);
}

run("websearch-wake", pool, main);
