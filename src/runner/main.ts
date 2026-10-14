import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import "../dotenv.js";
import { config } from "../config.js";
import { pastVisits, replayVisit } from "./backfill.js";
import { httpBoard } from "./board.js";
import { currentBriefs, defaultBriefs } from "./briefs.js";
import { runDryVisits } from "./dryvisit.js";
import { modelIdProblem, NanoGptModel, type ReasoningEffort } from "./model.js";
import { insertDiary } from "./diary.js";
import { probeModels } from "./probe.js";
import { runReflectTest } from "./reflecttest.js";
import { Runner } from "./runner.js";
import { loadQueries, runSearchProbe } from "./searchprobe.js";
import { EFFORTS } from "./settings.js";
import { allBots, createRunnerPool, RUNNER_LOCK_KEY, type Bot } from "./store.js";
import { Summarizer } from "./summaries.js";
import { loadScenarios, runVoiceProbe, type Persona } from "./voice.js";
import { runVoiceTest } from "./voicetest.js";
import {
  RECENCIES,
  RESEARCHER,
  SEARCH_SERVICES,
  searchBackend,
  searchResultText,
  WebSearch,
  type Recency,
  type Researcher,
  type SearchService,
} from "./websearch.js";

/**
 * The bot runner: `npm run runner`. One process wakes every bot, one at a
 * time, on its schedule. It needs RUNNER_DATABASE_URL (the fritter_bots role,
 * which has the bots schema only), MCP_URL (the board's MCP server), and each
 * bot's NanoGPT key and board token under the env var names in its config,
 * the summary model's key (runner.summary_key_env), and for web search the
 * research key (runner.web_search_key_env) and the search services' keys.
 *
 *   npm run runner                          run until stopped
 *   npm run runner -- probe [--key-env VAR] <model>...
 *                                           check models on NanoGPT (key in VAR, or NANOGPT_PROBE_KEY)
 *   npm run runner -- probe [--key-env VAR] --voice <persona>[,<persona>...] <model>...
 *                                           the same, then a sample post from each model as each
 *                                           persona (personas/<name>.md) in each scenario of
 *                                           config/voice-probe.yaml: a Markdown report on stdout
 *       --effort low,high                   write each sample at each of these efforts
 *       --no-checks                         skip the mechanical checks (for models already probed)
 *   npm run runner -- search-probe [--key-env VAR] [--only <service>[,<service>...]]
 *                                           each query in config/search-probe.yaml through each
 *                                           search service with a key (runner.web_search_keys),
 *                                           summarized by the research model on VAR's NanoGPT key
 *                                           (or NANOGPT_PROBE_KEY): a Markdown report on stdout
 *       --models <model>[@<effort>],...     summarize each result set with each of these instead
 *   npm run runner -- web-search [--recent day|week|month|year] <query>...
 *                                           one search as a bot would make it, with runner.env's
 *                                           keys, printed with its pages; nothing is recorded
 *   npm run runner -- voice-test [--key-env VAR] [--drafts DIR] [--brief FILE] [--repeat N]
 *                                [--no-control] [--side NAME]... <bot>...
 *                                           sample posts from each bot on its own model, under each
 *                                           side of its persona (drafts in DIR/<name>.md instead, if
 *                                           given), in each scenario of config/voice-probe.yaml, with
 *                                           today's prompts as the control: a Markdown report on stdout;
 *                                           --side (repeatable) samples only the sides named
 *   npm run runner -- dry-visit [--key-env VAR] [--drafts DIR] [--brief FILE] [--side NAME | --each-side]
 *                                <bot>...
 *                                           a whole visit by each bot on the live board, on VAR's key,
 *                                           over a look-only connection: what it would have posted, in a
 *                                           Markdown report on stdout; the board gets nothing
 *   npm run runner -- backfill-diary [--write] [<bot>...]
 *                                           the diary entries the past visits still in bots.runs would
 *                                           have written, printed; with --write, saved, dated at each
 *                                           visit (visits that already have one are skipped). No model call
 *   npm run runner -- reflect-test [--key-env VAR] [--brief FILE] <bot>...
 *                                           each bot's weekly reflection now, on its own model and VAR's
 *                                           key, with FILE's reflection brief if given: the new standing
 *                                           notes next to today's in a Markdown report; nothing is saved
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

async function run(): Promise<void> {
  const url = process.env["RUNNER_DATABASE_URL"];
  if (!url) throw new Error("RUNNER_DATABASE_URL is required (the fritter_bots role).");
  const mcpUrl = process.env["MCP_URL"] ?? "http://127.0.0.1:3101/mcp";
  const pool = createRunnerPool(url);

  // One runner at a time: a second one waits here until the first stops.
  const lockClient = await pool.connect();
  let stopping = false;
  const stop = () => {
    stopping = true;
    log("Stopping.");
    // A wake in progress is abandoned; the next start marks its run failed,
    // and the bot's cursor hasn't moved, so its inbox is seen again.
    lockClient.release();
    pool.end().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  for (let waited = false; ; waited = true) {
    const { rows } = await lockClient.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [RUNNER_LOCK_KEY]);
    if (rows[0]!.ok) break;
    if (!waited) log("Another runner is active; waiting for it to stop.");
    await sleep(config.runner.tick_seconds * 1000);
  }

  const summaryKey = process.env[config.runner.summary_key_env]?.trim();
  if (!summaryKey) log(`${config.runner.summary_key_env} isn't set: bots will read long threads without summaries.`);
  const summarizer = summaryKey ? new Summarizer(new NanoGptModel(summaryKey), { now: () => new Date(), sleep }) : null;
  const webSearch = webSearchFromEnv();

  const runner = new Runner({
    summarizer,
    webSearch,
    db: pool,
    connectBoard: httpBoard(mcpUrl),
    modelFor: (key) => new NanoGptModel(key),
    secret: (name) => process.env[name]?.trim() || undefined,
    now: () => new Date(),
    random: Math.random,
    sleep,
    log,
  });
  await runner.start();
  log(`Runner started; board at ${mcpUrl}.`);
  while (!stopping) {
    try {
      await runner.tick();
    } catch (err) {
      log(`Tick failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
    await sleep(config.runner.tick_seconds * 1000);
  }
}

/**
 * The bots' web search, from runner.env: the services with keys, in the
 * configured order, and the research key. Without the research key or any
 * service, bots get no web_search, and the log says why.
 */
function webSearchFromEnv(): WebSearch | null {
  const r = config.runner;
  const researchKey = process.env[r.web_search_key_env]?.trim();
  const backends = r.web_search_services.flatMap((s) => {
    const k = process.env[r.web_search_keys[s]]?.trim();
    return k ? [searchBackend(s, k)] : [];
  });
  const missing = r.web_search_services.filter((s) => !backends.some((b) => b.service === s)).map((s) => r.web_search_keys[s]);
  if (!researchKey || !backends.length) {
    log(`Web search is off: ${!researchKey ? `${r.web_search_key_env} isn't set` : `no search service has a key (${missing.join(", ")})`}.`);
    return null;
  }
  if (missing.length) log(`Web search runs without ${missing.join(", ")}.`);
  log(`Web search: ${backends.map((b) => b.service).join(", then ")}; research by ${r.web_search_models.map((m) => m.model).join(", then ")}.`);
  return new WebSearch(backends, new NanoGptModel(researchKey), { now: () => new Date() });
}

/**
 * Writes to stdout and waits for it to drain. Through a pipe (docker compose
 * exec) stdout is asynchronous, and exiting straight after a write keeps only
 * the first 64 KiB.
 */
const printAll = (text: string) => new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));

const PERSONAS_DIR = path.join(import.meta.dirname, "..", "..", "personas");
const PROBE_USAGE =
  "Usage: npm run runner -- probe [--key-env VAR] [--voice <persona>[,<persona>...] [--effort <effort>[,<effort>...]] [--no-checks]] <model> [<model>...]";

/** Personas by file name (personas/<name>.md), for the voice probe. */
function loadPersonas(list: string): Persona[] {
  return list.split(",").map((name) => {
    name = name.trim();
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`${name || "(empty)"}: a persona is named by its file in personas/, like captain-boday.`);
    return { name, text: readFileSync(path.join(PERSONAS_DIR, `${name}.md`), "utf-8").trim() };
  });
}

/** The member brief bots get now: the admin's edit if there is one and the database is reachable. */
async function memberBrief(): Promise<{ text: string; source: string }> {
  const url = process.env["RUNNER_DATABASE_URL"];
  const shipped = { text: defaultBriefs().member, source: "as shipped" };
  if (!url) return shipped;
  const pool = createRunnerPool(url);
  try {
    const current = (await currentBriefs(pool)).member;
    return { text: current, source: current === shipped.text ? "as shipped" : "as edited at /admin/briefs" };
  } catch (err) {
    console.error(`Couldn't read the briefs (${err instanceof Error ? err.message : String(err)}); using the shipped member brief.`);
    return shipped;
  } finally {
    await pool.end();
  }
}

async function probe(args: string[]): Promise<void> {
  // The key is named, never given on the command line: --key-env VAR, or NANOGPT_PROBE_KEY.
  let keyEnv = "NANOGPT_PROBE_KEY";
  let voice: string | null = null;
  let efforts: ReasoningEffort[] | undefined;
  let checks = true;
  while (args[0]?.startsWith("--")) {
    const flag = args.shift()!;
    if (flag === "--no-checks") {
      checks = false;
      continue;
    }
    const value = args.shift();
    if (value === undefined) throw new Error(PROBE_USAGE);
    if (flag === "--key-env") keyEnv = value;
    else if (flag === "--voice") voice = value;
    else if (flag === "--effort") {
      efforts = value.split(",").map((e) => e.trim()) as ReasoningEffort[];
      const bad = efforts.find((e) => !(EFFORTS as readonly string[]).includes(e));
      if (bad !== undefined || efforts.length === 0) throw new Error(`An effort is one of ${EFFORTS.join(", ")}.`);
    } else throw new Error(`Unknown option ${flag}. ${PROBE_USAGE}`);
  }
  if (voice === null && (efforts || !checks)) throw new Error(`--effort and --no-checks go with --voice. ${PROBE_USAGE}`);
  const key = process.env[keyEnv]?.trim();
  if (!key) throw new Error(`Set ${keyEnv || "NANOGPT_PROBE_KEY"} to a NanoGPT key to probe with.`);
  if (args.length === 0) throw new Error(PROBE_USAGE);
  const chat = new NanoGptModel(key);
  if (voice === null) {
    // Progress on stderr, the table on stdout.
    const table: string[] = [];
    const ok = await probeModels(chat, args, (line) => (line.startsWith("Probing ") ? console.error(line) : table.push(line)));
    await printAll(`${table.join("\n")}\n`);
    process.exit(ok ? 0 : 1);
  }
  // Check everything that can be wrong locally before spending a request.
  const personas = loadPersonas(voice);
  const scenarios = loadScenarios();
  const brief = await memberBrief();
  const report = await runVoiceProbe(
    { chat, now: () => new Date(), sleep, log: (line) => console.error(`${new Date().toISOString()} ${line}`) },
    { models: args, personas, scenarios, memberBrief: brief.text, briefSource: brief.source, efforts, checks }
  );
  await printAll(report);
  process.exit(0);
}

/** A bot's persona file name: its username in lower case, other characters as hyphens (Captain Boday → captain-boday). */
const personaSlug = (username: string) => username.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The options the voice test and dry visits share, read off the front of args. */
function testOptions(args: string[], usage: string, more: Record<string, (value: string | null) => void> = {}) {
  const o = { keyEnv: "NANOGPT_PROBE_KEY", drafts: null as string | null, brief: null as string | null };
  while (args[0]?.startsWith("--")) {
    const flag = args.shift()!;
    const handler = more[flag];
    if (handler && handler.length === 0) {
      handler(null);
      continue;
    }
    const value = args.shift();
    if (value === undefined) throw new Error(usage);
    if (flag === "--key-env") o.keyEnv = value;
    else if (flag === "--drafts") o.drafts = value;
    else if (flag === "--brief") o.brief = value;
    else if (handler) handler(value);
    else throw new Error(`Unknown option ${flag}. ${usage}`);
  }
  if (args.length === 0) throw new Error(usage);
  const key = process.env[o.keyEnv]?.trim();
  if (!key) throw new Error(`Set ${o.keyEnv} to a NanoGPT key to test with.`);
  return { ...o, key };
}

/** The bots named, from the database, in the order given. */
async function namedBots(db: Parameters<typeof allBots>[0], names: string[]): Promise<Bot[]> {
  const bots = await allBots(db);
  return names.map((name) => bots.find((b) => b.username.toLowerCase() === name.trim().toLowerCase()) ?? fail(`There's no bot called ${name}.`));
}

const fail = (message: string): never => {
  throw new Error(message);
};

/** Each bot's draft persona from DIR/<slug>.md, where there is one. */
function draftPersonas(dir: string | null, bots: Bot[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!dir) return out;
  for (const b of bots) {
    const file = path.join(dir, `${personaSlug(b.username)}.md`);
    if (existsSync(file)) out.set(b.username, readFileSync(file, "utf-8").trim());
  }
  return out;
}

const VOICE_TEST_USAGE =
  "Usage: npm run runner -- voice-test [--key-env VAR] [--drafts DIR] [--brief FILE] [--repeat N] [--no-control] [--side NAME]... <bot> [<bot>...]";

async function voiceTest(args: string[]): Promise<void> {
  let repeat = 3;
  let control = true;
  const sides: string[] = [];
  const o = testOptions(args, VOICE_TEST_USAGE, {
    "--side": (v) => {
      sides.push(v!);
    },
    "--repeat": (v) => {
      repeat = Number(v);
      if (!Number.isInteger(repeat) || repeat < 1) throw new Error("--repeat is a whole number of samples, 1 or more.");
    },
    "--no-control": () => {
      control = false;
    },
  });
  const url = process.env["RUNNER_DATABASE_URL"] ?? fail("RUNNER_DATABASE_URL is required, for the bots' models and personas.");
  const pool = createRunnerPool(url);
  try {
    const bots = await namedBots(pool, args);
    const drafts = draftPersonas(o.drafts, bots);
    const current = await memberBrief();
    const brief = o.brief ? { text: readFileSync(o.brief, "utf-8").trim(), source: `from ${o.brief}` } : current;
    const scenarios = loadScenarios();
    const report = await runVoiceTest(
      { chat: new NanoGptModel(o.key), now: () => new Date(), random: Math.random, sleep, log: (line) => console.error(`${new Date().toISOString()} ${line}`) },
      {
        bots: bots.map((b) => ({ name: b.username, model: b.model, effort: b.reasoningEffort, persona: drafts.get(b.username) ?? b.personaPrompt, current: b.personaPrompt })),
        scenarios,
        repeat,
        memberBrief: brief.text,
        briefSource: brief.source,
        personaSource: o.drafts ? `from ${o.drafts} where there's a draft (${[...drafts.keys()].join(", ") || "none"}), otherwise as set` : "as set",
        control: control ? { memberBrief: current.text, briefSource: current.source } : null,
        ...(sides.length ? { sides } : {}),
        edited: bots
          .filter((b) => {
            const file = path.join(PERSONAS_DIR, `${personaSlug(b.username)}.md`);
            return !existsSync(file) || readFileSync(file, "utf-8").trim() !== b.personaPrompt.trim();
          })
          .map((b) => ({ name: b.username, text: b.personaPrompt })),
      }
    );
    await printAll(report);
  } finally {
    await pool.end();
  }
  process.exit(0);
}

const DRY_VISIT_USAGE =
  "Usage: npm run runner -- dry-visit [--key-env VAR] [--drafts DIR] [--brief FILE] [--side NAME | --each-side] <bot> [<bot>...]";

async function dryVisit(args: string[]): Promise<void> {
  let sides = "pick";
  const o = testOptions(args, DRY_VISIT_USAGE, {
    "--side": (v) => {
      sides = v!;
    },
    "--each-side": () => {
      sides = "each";
    },
  });
  const url = process.env["RUNNER_DATABASE_URL"] ?? fail("RUNNER_DATABASE_URL is required (the fritter_bots role).");
  const mcpUrl = process.env["MCP_URL"] ?? "http://127.0.0.1:3101/mcp";
  const pool = createRunnerPool(url);
  try {
    const bots = await namedBots(pool, args);
    const drafts = draftPersonas(o.drafts, bots);
    const brief = o.brief ? { text: readFileSync(o.brief, "utf-8").trim(), source: `from ${o.brief}` } : null;
    const summaryKey = process.env[config.runner.summary_key_env]?.trim();
    const report = await runDryVisits(
      {
        db: pool,
        connectBoard: httpBoard(mcpUrl),
        modelFor: (key) => new NanoGptModel(key),
        secret: (name) => process.env[name]?.trim() || undefined,
        now: () => new Date(),
        random: Math.random,
        sleep,
        summarizer: summaryKey ? new Summarizer(new NanoGptModel(summaryKey), { now: () => new Date(), sleep }) : null,
        webSearch: null,
        log: (line) => console.error(`${new Date().toISOString()} ${line}`),
      },
      {
        bots,
        apiKey: o.key,
        sides,
        personas: drafts,
        personaSource: o.drafts ? `from ${o.drafts} where there's a draft (${[...drafts.keys()].join(", ") || "none"}), otherwise as set` : "as set",
        ...(brief ? { memberBrief: brief.text } : {}),
        briefSource: brief?.source ?? "as bots get it now",
      }
    );
    await printAll(report);
  } finally {
    await pool.end();
  }
  process.exit(0);
}

const BACKFILL_USAGE = "Usage: npm run runner -- backfill-diary [--write] [<bot>...]";

async function backfillDiary(args: string[]): Promise<void> {
  let write = false;
  while (args[0]?.startsWith("--")) {
    const flag = args.shift()!;
    if (flag === "--write") write = true;
    else throw new Error(`Unknown option ${flag}. ${BACKFILL_USAGE}`);
  }
  const url = process.env["RUNNER_DATABASE_URL"] ?? fail("RUNNER_DATABASE_URL is required (the fritter_bots role).");
  const pool = createRunnerPool(url);
  try {
    if (args.length) await namedBots(pool, args);
    const visits = await pastVisits(pool, args);
    const counts = new Map<string, { visits: number; entries: number }>();
    const lines: string[] = [];
    for (const v of visits) {
      const c = counts.get(v.username) ?? { visits: 0, entries: 0 };
      counts.set(v.username, c);
      c.visits++;
      let entry: string | null = null;
      try {
        entry = replayVisit(v);
      } catch (err) {
        lines.push(`${v.username} run ${v.id}: couldn't be read (${err instanceof Error ? err.message : String(err)})`);
        continue;
      }
      if (!entry) continue;
      c.entries++;
      lines.push(`${v.username} run ${v.id}, ${v.startedAt.toISOString()}: ${entry}`);
      if (write) await insertDiary(pool, v.userId, v.id, entry, v.startedAt);
    }
    lines.push(
      "",
      ...[...counts].map(([name, c]) => `${name}: ${c.visits} past visit(s), ${c.entries} with something to write${write ? ", saved" : ""}.`),
      visits.length ? (write ? "Saved." : "Nothing saved; run again with --write to save these.") : "No past visits without a diary entry."
    );
    await printAll(`${lines.join("\n")}\n`);
  } finally {
    await pool.end();
  }
  process.exit(0);
}

const REFLECT_TEST_USAGE = "Usage: npm run runner -- reflect-test [--key-env VAR] [--brief FILE] <bot> [<bot>...]";

async function reflectTest(args: string[]): Promise<void> {
  const o = testOptions(args, REFLECT_TEST_USAGE);
  if (o.drafts) throw new Error(`reflect-test takes no --drafts. ${REFLECT_TEST_USAGE}`);
  const url = process.env["RUNNER_DATABASE_URL"] ?? fail("RUNNER_DATABASE_URL is required (the fritter_bots role).");
  const pool = createRunnerPool(url);
  try {
    const bots = await namedBots(pool, args);
    const report = await runReflectTest(
      { db: pool, chat: new NanoGptModel(o.key), now: () => new Date(), sleep, log: (line) => console.error(`${new Date().toISOString()} ${line}`) },
      bots,
      o.brief ? { brief: readFileSync(o.brief, "utf-8").trim(), briefSource: `from ${o.brief}` } : { briefSource: "as in the code" }
    );
    await printAll(report);
  } finally {
    await pool.end();
  }
  process.exit(0);
}

const SEARCH_PROBE_USAGE =
  "Usage: npm run runner -- search-probe [--key-env VAR] [--only <service>[,<service>...]] [--models <model>[@<effort>][,...]]";

/** `vendor/model@low,other/model`: research models, each at an effort (the configured one if none). */
function parseResearchers(list: string): Researcher[] {
  return list.split(",").map((item) => {
    const [model = "", effort = RESEARCHER.effort, extra] = item.trim().split("@");
    const problem = modelIdProblem(model);
    if (problem) throw new Error(problem);
    if (extra !== undefined || !(EFFORTS as readonly string[]).includes(effort)) throw new Error(`${item.trim()}: an effort is one of ${EFFORTS.join(", ")}.`);
    return { model, effort: effort as ReasoningEffort };
  });
}

async function searchProbe(args: string[]): Promise<void> {
  let keyEnv = "NANOGPT_PROBE_KEY";
  let only: SearchService[] = [...SEARCH_SERVICES];
  let researchers: Researcher[] | undefined;
  while (args.length) {
    const flag = args.shift()!;
    const value = args.shift();
    if (value === undefined) throw new Error(SEARCH_PROBE_USAGE);
    if (flag === "--key-env") keyEnv = value;
    else if (flag === "--only") {
      only = value.split(",").map((s) => s.trim()) as SearchService[];
      const bad = only.find((s) => !(SEARCH_SERVICES as readonly string[]).includes(s));
      if (bad !== undefined || only.length === 0) throw new Error(`A service is one of ${SEARCH_SERVICES.join(", ")}.`);
    } else if (flag === "--models") researchers = parseResearchers(value);
    else throw new Error(`Unknown option ${flag}. ${SEARCH_PROBE_USAGE}`);
  }
  const key = process.env[keyEnv]?.trim();
  if (!key) throw new Error(`Set ${keyEnv} to a NanoGPT key for the research model.`);
  const keys = config.runner.web_search_keys;
  const backends = only.flatMap((s) => {
    const k = process.env[keys[s]]?.trim();
    return k ? [searchBackend(s, k)] : [];
  });
  const skipped = only.filter((s) => !backends.some((b) => b.service === s));
  for (const s of skipped) console.error(`${keys[s]} isn't set: skipping ${s}.`);
  if (!backends.length) throw new Error(`No search service has a key: set ${only.map((s) => keys[s]).join(", ")}.`);
  const queries = loadQueries();
  const report = await runSearchProbe(
    { backends, chat: new NanoGptModel(key), now: () => new Date(), sleep, log: (line) => console.error(`${new Date().toISOString()} ${line}`) },
    { queries, skipped, researchers }
  );
  await printAll(report);
  process.exit(0);
}

const WEB_SEARCH_USAGE = "Usage: npm run runner -- web-search [--recent day|week|month|year] <query>...";

/** One search through the bots' web search, to try it: printed, never recorded or counted. */
async function webSearchOnce(args: string[]): Promise<void> {
  let recency: Recency | null = null;
  if (args[0] === "--recent") {
    args.shift();
    const r = args.shift();
    if (!(RECENCIES as readonly (string | undefined)[]).includes(r)) throw new Error(WEB_SEARCH_USAGE);
    recency = r as Recency;
  }
  const query = args.join(" ").trim();
  if (!query) throw new Error(WEB_SEARCH_USAGE);
  const web = webSearchFromEnv();
  if (!web) process.exit(1);
  const r = await web.search(query, recency);
  const lines = [
    `Search: "${query}"${recency ? ` (last ${recency})` : ""}`,
    `Outcome: ${r.outcome}. Service: ${r.service ?? "none"}. Research: ${r.researchModel ?? "none"} (${r.researchCalls} call${r.researchCalls === 1 ? "" : "s"}).`,
    ...(r.errors.length ? [`Along the way: ${r.errors.join(" | ")}`] : []),
    "",
    "What the bot would get:",
    searchResultText(r, 0),
    ...(r.hits.length ? ["", "Pages:", ...r.hits.map((h, i) => `${i + 1}. ${h.title} (${h.site}, ${h.published ?? "undated"}) ${h.url}`)] : []),
  ];
  await printAll(`${lines.join("\n")}\n`);
  process.exit(r.outcome === "ok" || r.outcome === "no_results" ? 0 : 1);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "probe") return probe(rest);
  if (command === "search-probe") return searchProbe(rest);
  if (command === "web-search") return webSearchOnce(rest);
  if (command === "voice-test") return voiceTest(rest);
  if (command === "dry-visit") return dryVisit(rest);
  if (command === "backfill-diary") return backfillDiary(rest);
  if (command === "reflect-test") return reflectTest(rest);
  if (command !== undefined)
    throw new Error(
      `Unknown command ${command}. Usage: npm run runner [-- probe … | search-probe … | web-search … | voice-test … | dry-visit … | backfill-diary … | reflect-test …]`
    );
  await run();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
