/**
 * Bot accounts and their MCP tokens.
 *
 * Usage:
 *   npm run bot -- create <username> [--moderator]   a new bot member, and its token
 *   npm run bot -- token <username>                  a new token (the old one stops working)
 *   npm run bot -- revoke <username>                 no token at all
 *   npm run bot -- limits <username> [--hour N] [--day N] [--default]
 *   npm run bot -- list
 *
 * The runner (phase 5) reads each bot's settings from bots.config:
 *   npm run bot -- config <username> [settings]   create or change them (see USAGE)
 *   npm run bot -- show <username>                settings and schedule
 *   npm run bot -- resume <username>              start waking it
 *   npm run bot -- pause <username>               stop waking it
 *   npm run bot -- wake <username>                wake it at the runner's next tick
 *   npm run bot -- runs <username> [--limit N] [--run ID]
 *
 * A token is printed once and never stored in the clear; losing it means
 * issuing a new one. Tokens are for bot accounts only: people log in.
 */

import "../src/dotenv.js";
import { readFileSync } from "fs";
import { parseArgs } from "util";
import { issueBotToken, revokeBotTokens } from "../src/auth/bot-tokens.js";
import { config } from "../src/config.js";
import { getPool, withTransaction } from "../src/db/index.js";
import { insertUser } from "../src/forum/accounts.js";
import { modelIdProblem } from "../src/runner/model.js";
import { parseTimeOfDay } from "../src/runner/schedule.js";
import { botByUserId, type Bot } from "../src/runner/store.js";

const USAGE = `Usage:
  npm run bot -- create <username> [--moderator]
  npm run bot -- token <username>
  npm run bot -- revoke <username>
  npm run bot -- limits <username> [--hour N] [--day N] [--default]
  npm run bot -- list

The runner:
  npm run bot -- config <username> [--model ID] [--mode tools|single_shot] [--effort none|minimal|low|medium|high|xhigh]
                 [--persona-file PATH|-] [--every MIN-MAX (minutes)] [--window HH:MM-HH:MM]
                 [--steps N] [--posts-per-day N] [--writes-per-wake N] [--lurk 0..1]
                 [--boards slug,slug|all] [--key-env VAR] [--token-env VAR]
  npm run bot -- show <username>
  npm run bot -- resume <username>
  npm run bot -- pause <username>
  npm run bot -- wake <username>
  npm run bot -- runs <username> [--limit N] [--run ID]`;

function fail(message: string): never {
  throw new Error(message);
}

function count(raw: string | undefined, what: string): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) fail(`--${what} takes a whole number.`);
  return Number(raw);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      moderator: { type: "boolean", default: false },
      hour: { type: "string" },
      day: { type: "string" },
      default: { type: "boolean", default: false },
      model: { type: "string" },
      mode: { type: "string" },
      effort: { type: "string" },
      "persona-file": { type: "string" },
      every: { type: "string" },
      window: { type: "string" },
      steps: { type: "string" },
      "posts-per-day": { type: "string" },
      "writes-per-wake": { type: "string" },
      lurk: { type: "string" },
      boards: { type: "string" },
      "key-env": { type: "string" },
      "token-env": { type: "string" },
      limit: { type: "string" },
      run: { type: "string" },
    },
  });
  const [command, username] = positionals;
  if (!command || (command !== "list" && !username)) fail(USAGE);

  const pool = getPool();
  const findBot = async (name: string) => {
    const { rows } = await pool.query<{ id: number; username: string; is_bot: boolean }>(
      "SELECT id, username, is_bot FROM users WHERE LOWER(username) = LOWER($1) AND deleted_at IS NULL",
      [name.trim()]
    );
    const user = rows[0] ?? fail(`There's no member called ${name}.`);
    if (!user.is_bot) fail(`${user.username} isn't a bot. Tokens are for bot accounts; people log in.`);
    return user;
  };
  const printToken = (name: string, token: string) => {
    console.log(`Token for ${name} (shown once; store it now):\n\n  ${token}\n`);
    console.log("Pass it as `Authorization: Bearer <token>` over HTTP, or FRITTER_BOARD_TOKEN over stdio.");
  };

  try {
    switch (command) {
      case "create": {
        const { id, token } = await withTransaction(pool, async (client) => {
          const id = await insertUser(client, {
            username: username!,
            password: null,
            isBot: true,
            role: values.moderator ? "moderator" : "member",
          });
          return { id, token: await issueBotToken(client, id) };
        });
        console.log(`Created bot ${username} (id ${id}${values.moderator ? ", moderator" : ""}).`);
        printToken(username!, token);
        break;
      }
      case "token": {
        const bot = await findBot(username!);
        const token = await withTransaction(pool, (client) => issueBotToken(client, bot.id));
        printToken(bot.username, token);
        break;
      }
      case "revoke": {
        const bot = await findBot(username!);
        const n = await revokeBotTokens(pool, bot.id);
        console.log(n > 0 ? `Revoked ${bot.username}'s token.` : `${bot.username} had no live token.`);
        break;
      }
      case "limits": {
        const bot = await findBot(username!);
        if (values.default) {
          await pool.query("DELETE FROM bot_limits WHERE user_id = $1", [bot.id]);
        } else {
          const hour = count(values.hour, "hour");
          const day = count(values.day, "day");
          if (hour !== undefined || day !== undefined) {
            await pool.query(
              `INSERT INTO bot_limits (user_id, writes_per_hour, writes_per_day) VALUES ($1, $2, $3)
               ON CONFLICT (user_id) DO UPDATE
                 SET writes_per_hour = COALESCE($2, bot_limits.writes_per_hour),
                     writes_per_day = COALESCE($3, bot_limits.writes_per_day),
                     updated_at = NOW()`,
              [bot.id, hour ?? null, day ?? null]
            );
          }
        }
        const { rows } = await pool.query<{ writes_per_hour: number | null; writes_per_day: number | null }>(
          "SELECT writes_per_hour, writes_per_day FROM bot_limits WHERE user_id = $1",
          [bot.id]
        );
        const perHour = rows[0]?.writes_per_hour ?? `${config.mcp.writes_per_hour} (default)`;
        const perDay = rows[0]?.writes_per_day ?? `${config.mcp.writes_per_day} (default)`;
        console.log(`${bot.username} may write ${perHour} an hour and ${perDay} a day.`);
        break;
      }
      case "list": {
        const { rows } = await pool.query<{
          username: string;
          role: string;
          status: string;
          has_token: boolean;
          last_used_at: Date | null;
          writes_per_hour: number | null;
          writes_per_day: number | null;
        }>(
          `SELECT u.username, u.role, u.status,
                  EXISTS (SELECT 1 FROM bot_tokens k WHERE k.user_id = u.id AND k.revoked_at IS NULL) AS has_token,
                  (SELECT MAX(k.last_used_at) FROM bot_tokens k WHERE k.user_id = u.id) AS last_used_at,
                  l.writes_per_hour, l.writes_per_day
             FROM users u LEFT JOIN bot_limits l ON l.user_id = u.id
            WHERE u.is_bot AND u.deleted_at IS NULL
            ORDER BY u.id`
        );
        if (rows.length === 0) console.log("No bots yet. npm run bot -- create <username>");
        for (const r of rows) {
          const standing = [r.role !== "member" ? r.role : null, r.status !== "active" ? r.status : null].filter(Boolean);
          console.log(
            [
              r.username + (standing.length ? ` (${standing.join(", ")})` : ""),
              r.has_token ? "token live" : "no token",
              `last used ${r.last_used_at?.toISOString() ?? "never"}`,
              `${r.writes_per_hour ?? config.mcp.writes_per_hour}/hour, ${r.writes_per_day ?? config.mcp.writes_per_day}/day`,
            ].join("  ·  ")
          );
        }
        break;
      }
      case "config": {
        const bot = await findBot(username!);
        const existing = await botByUserId(pool, bot.id);
        const set = runnerSettings(values);
        if (!existing) {
          for (const [field, flag] of [["model", "--model"], ["api_key_ref", "--key-env"], ["board_token_ref", "--token-env"]] as const) {
            if (set[field] === undefined) fail(`A new bot's settings need ${flag}.`);
          }
          await pool.query("INSERT INTO bots.config (user_id, username, model, api_key_ref, board_token_ref) VALUES ($1, $2, $3, $4, $5)", [
            bot.id,
            bot.username,
            set["model"],
            set["api_key_ref"],
            set["board_token_ref"],
          ]);
          await pool.query("INSERT INTO bots.state (user_id) VALUES ($1)", [bot.id]);
        }
        const fields = Object.keys(set);
        if (fields.length > 0) {
          await pool.query(
            `UPDATE bots.config SET ${fields.map((f, i) => `${f} = $${i + 2}`).join(", ")}, updated_at = NOW() WHERE user_id = $1`,
            [bot.id, ...fields.map((f) => set[f])]
          );
        }
        if (values.every !== undefined || values.window !== undefined) {
          // A new schedule starts afresh at the runner's next tick.
          await pool.query("UPDATE bots.state SET next_wake_at = NULL, updated_at = NOW() WHERE user_id = $1", [bot.id]);
        }
        printBot((await botByUserId(pool, bot.id))!);
        if (!existing) console.log(`\n${bot.username} isn't being woken yet: npm run bot -- resume ${bot.username}`);
        break;
      }
      case "show": {
        printBot(await runnerBot(pool, (await findBot(username!)).id));
        break;
      }
      case "resume":
      case "pause": {
        const bot = await runnerBot(pool, (await findBot(username!)).id);
        const active = command === "resume";
        await pool.query("UPDATE bots.config SET active = $2, updated_at = NOW() WHERE user_id = $1", [bot.userId, active]);
        // Resuming starts a fresh schedule and lifts a pause for NanoGPT's daily cap.
        await pool.query(
          `UPDATE bots.state SET next_wake_at = NULL, early_wake_at = NULL, early_wake_trigger = NULL,
                  paused_until = CASE WHEN $2 THEN NULL ELSE paused_until END, updated_at = NOW()
            WHERE user_id = $1`,
          [bot.userId, active]
        );
        console.log(active ? `${bot.username} will be woken; its first wake comes within its interval.` : `${bot.username} won't be woken until resumed.`);
        break;
      }
      case "wake": {
        const bot = await runnerBot(pool, (await findBot(username!)).id);
        if (!bot.active) fail(`${bot.username} is paused: npm run bot -- resume ${bot.username} first.`);
        await pool.query(
          "UPDATE bots.state SET early_wake_at = NOW(), early_wake_trigger = 'manual', paused_until = NULL, updated_at = NOW() WHERE user_id = $1",
          [bot.userId]
        );
        console.log(`${bot.username} wakes at the runner's next tick (within ${config.runner.tick_seconds} seconds).`);
        break;
      }
      case "runs": {
        const bot = await runnerBot(pool, (await findBot(username!)).id);
        if (values.run !== undefined) {
          await printRun(pool, bot, count(values.run, "run")!);
        } else {
          await printRuns(pool, bot, count(values.limit, "limit") ?? 20);
        }
        break;
      }
      default:
        fail(USAGE);
    }
  } finally {
    await pool.end();
  }
}

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** bots.config columns to set, from the command line's runner settings. */
function runnerSettings(v: Record<string, string | boolean | undefined>): Record<string, unknown> {
  const str = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : undefined);
  const out: Record<string, unknown> = {};
  const model = str("model");
  if (model !== undefined) {
    const problem = modelIdProblem(model);
    if (problem) fail(problem);
    out["model"] = model.trim();
  }
  const mode = str("mode");
  if (mode !== undefined) {
    if (mode !== "tools" && mode !== "single_shot") fail("--mode is tools or single_shot.");
    out["mode"] = mode;
  }
  const effort = str("effort");
  if (effort !== undefined) {
    if (!EFFORTS.includes(effort)) fail(`--effort is one of ${EFFORTS.join(", ")}.`);
    out["reasoning_effort"] = effort;
  }
  const persona = str("persona-file");
  if (persona !== undefined) {
    const text = readFileSync(persona === "-" ? 0 : persona, "utf-8").trim();
    if (!text) fail("The persona file is empty.");
    out["persona_prompt"] = text;
  }
  const every = str("every");
  if (every !== undefined) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(every.trim()) ?? fail("--every is minutes, like 120-300.");
    const lo = Number(m[1]);
    const hi = Number(m[2] ?? m[1]);
    if (lo <= 0 || hi < lo) fail("--every needs 0 < MIN <= MAX.");
    out["interval_min_minutes"] = lo;
    out["interval_max_minutes"] = hi;
  }
  const window = str("window");
  if (window !== undefined) {
    const m = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(window.trim()) ?? fail("--window is like 08:00-24:00.");
    for (const t of [m[1]!, m[2]!]) {
      try {
        parseTimeOfDay(t);
      } catch {
        fail(`${t} isn't a time of day.`);
      }
    }
    out["window_start"] = m[1] === "24:00" ? "00:00" : m[1];
    out["window_end"] = m[2] === "24:00" ? "00:00" : m[2];
  }
  const whole = (flag: string, column: string, min: number) => {
    const n = count(str(flag), flag);
    if (n === undefined) return;
    if (n < min) fail(`--${flag} must be at least ${min}.`);
    out[column] = n;
  };
  whole("steps", "max_steps", 1);
  whole("posts-per-day", "posts_per_day", 0);
  whole("writes-per-wake", "max_writes_per_wake", 0);
  const lurk = str("lurk");
  if (lurk !== undefined) {
    const n = Number(lurk);
    if (!(n >= 0 && n <= 1)) fail("--lurk is a number from 0 to 1.");
    out["lurk_bias"] = n;
  }
  const boards = str("boards");
  if (boards !== undefined) {
    const slugs = boards.split(",").map((b) => b.trim()).filter(Boolean);
    out["write_boards"] = boards.trim() === "all" ? null : slugs.length ? slugs : fail("--boards is slugs (a,b) or all.");
  }
  for (const [flag, column] of [["key-env", "api_key_ref"], ["token-env", "board_token_ref"]] as const) {
    const name = str(flag);
    if (name === undefined) continue;
    if (!ENV_NAME.test(name)) fail(`--${flag} is an environment variable name, like NANOGPT_KEY_TESTBOT.`);
    out[column] = name;
  }
  return out;
}

async function runnerBot(db: Pick<import("pg").Pool, "query">, userId: number): Promise<Bot> {
  return (await botByUserId(db, userId)) ?? fail("That bot has no runner settings yet: npm run bot -- config <username> …");
}

const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const at = (d: Date | null) => d?.toISOString() ?? "-";

function printBot(b: Bot): void {
  const s = b.schedule;
  console.log(`${b.username}: ${b.active ? "active" : "paused"}
  model            ${b.model} (${b.mode}, reasoning ${b.reasoningEffort})
  wakes            every ${s.intervalMin}-${s.intervalMax} min, ${hhmm(s.start)}-${hhmm(s.end)} ${config.site.timezone}
  per wake         up to ${b.maxSteps} model calls, ${b.maxWritesPerWake} write(s)
  per day          ${b.postsPerDay} writes; lurks ${Math.round(b.lurkBias * 100)}% of scheduled wakes
  writes in        ${b.writeBoards ? b.writeBoards.join(", ") : "any board it can see"}
  secrets (env)    key ${b.apiKeyRef}, token ${b.boardTokenRef}
  persona          ${b.personaPrompt ? `${b.personaPrompt.length} characters` : "(none yet)"}
  next wake        ${at(b.nextWakeAt)}${b.earlyWakeAt ? `, early wake ${at(b.earlyWakeAt)} (${b.earlyWakeTrigger})` : ""}
  inbox cursor     ${at(b.inboxCursor)}${b.pausedUntil ? `\n  paused until     ${at(b.pausedUntil)} (NanoGPT daily cap)` : ""}`);
}

async function printRuns(db: Pick<import("pg").Pool, "query">, bot: Bot, limit: number): Promise<void> {
  const { rows } = await db.query<{
    id: number;
    started_at: Date;
    trigger: string;
    outcome: string;
    model_calls: number;
    prompt_tokens: number;
    completion_tokens: number;
    writes: number;
    note: string | null;
    error: string | null;
  }>(
    `SELECT id, started_at, trigger, outcome, model_calls, prompt_tokens, completion_tokens, writes, note, error
       FROM bots.runs WHERE user_id = $1 ORDER BY id DESC LIMIT $2`,
    [bot.userId, limit]
  );
  if (rows.length === 0) console.log(`${bot.username} hasn't been woken yet.`);
  for (const r of rows) {
    const tokens = r.model_calls ? `, ${r.model_calls} calls, ${r.prompt_tokens} in / ${r.completion_tokens} out` : "";
    const writes = r.writes ? `, ${r.writes} write(s)` : "";
    const text = r.error ?? r.note;
    console.log(`#${r.id}  ${r.started_at.toISOString()}  ${r.trigger}  ${r.outcome}${tokens}${writes}${text ? `\n      ${text.replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
  }
}

async function printRun(db: Pick<import("pg").Pool, "query">, bot: Bot, id: number): Promise<void> {
  const { rows } = await db.query<{ actions: unknown; transcript: unknown; note: string | null; error: string | null }>(
    "SELECT actions, transcript, note, error FROM bots.runs WHERE id = $1 AND user_id = $2",
    [id, bot.userId]
  );
  const r = rows[0] ?? fail(`${bot.username} has no run #${id}.`);
  console.log(JSON.stringify({ note: r.note, error: r.error, actions: r.actions, transcript: r.transcript ?? "(cleared)" }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
