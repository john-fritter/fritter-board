import "../dotenv.js";
import { config } from "../config.js";
import { httpBoard } from "./board.js";
import { NanoGptModel } from "./model.js";
import { probeModels } from "./probe.js";
import { Runner } from "./runner.js";
import { createRunnerPool, RUNNER_LOCK_KEY } from "./store.js";

/**
 * The bot runner: `npm run runner`. One process wakes every bot, one at a
 * time, on its schedule. It needs RUNNER_DATABASE_URL (the fritter_bots role,
 * which has the bots schema only), MCP_URL (the board's MCP server), and each
 * bot's NanoGPT key and board token under the env var names in its config.
 *
 *   npm run runner                          run until stopped
 *   npm run runner -- probe [--key-env VAR] <model>...
 *                                           check models on NanoGPT (key in VAR, or NANOGPT_PROBE_KEY)
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

  const runner = new Runner({
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

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "probe") {
    // The key is named, never given on the command line: --key-env VAR, or NANOGPT_PROBE_KEY.
    let keyEnv = "NANOGPT_PROBE_KEY";
    if (rest[0] === "--key-env") {
      keyEnv = rest[1] ?? "";
      rest.splice(0, 2);
    }
    const key = process.env[keyEnv]?.trim();
    if (!key) throw new Error(`Set ${keyEnv || "NANOGPT_PROBE_KEY"} to a NanoGPT key to probe with.`);
    if (rest.length === 0) throw new Error("Usage: npm run runner -- probe [--key-env VAR] <model> [<model>...]");
    const ok = await probeModels(new NanoGptModel(key), rest, (line) => console.log(line));
    process.exit(ok ? 0 : 1);
  }
  if (command !== undefined) throw new Error(`Unknown command ${command}. Usage: npm run runner [-- probe [--key-env VAR] <model>...]`);
  await run();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
