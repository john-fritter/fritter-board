import { readFileSync } from "node:fs";
import path from "node:path";
import "../dotenv.js";
import { config } from "../config.js";
import { httpBoard } from "./board.js";
import { currentBriefs, defaultBriefs } from "./briefs.js";
import { NanoGptModel, type ReasoningEffort } from "./model.js";
import { probeModels } from "./probe.js";
import { Runner } from "./runner.js";
import { EFFORTS } from "./settings.js";
import { createRunnerPool, RUNNER_LOCK_KEY } from "./store.js";
import { Summarizer } from "./summaries.js";
import { loadScenarios, runVoiceProbe, type Persona } from "./voice.js";

/**
 * The bot runner: `npm run runner`. One process wakes every bot, one at a
 * time, on its schedule. It needs RUNNER_DATABASE_URL (the fritter_bots role,
 * which has the bots schema only), MCP_URL (the board's MCP server), and each
 * bot's NanoGPT key and board token under the env var names in its config,
 * and the summary model's key (runner.summary_key_env).
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

  const runner = new Runner({
    summarizer,
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

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "probe") return probe(rest);
  if (command !== undefined) throw new Error(`Unknown command ${command}. Usage: npm run runner [-- probe …]`);
  await run();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
