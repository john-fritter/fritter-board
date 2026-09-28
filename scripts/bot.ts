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
 * Its memory (phase 6):
 *   npm run bot -- standing <username> [--file PATH|-]   show, or replace, its standing notes
 *   npm run bot -- notes <username> [--about NAME] [--limit N]
 *   npm run bot -- compact <username>             fold every note into its standing notes at the next tick
 *
 * Settings changes are logged in bots.config_log, as by "cli"; the admin
 * pages at /admin/bots do all of this too.
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
import { currentStanding, noteLine, recallNotes } from "../src/runner/memory.js";
import { applyColumns, parseSettings, requestCompaction, requestWake, setActive, writeStanding } from "../src/runner/settings.js";
import { botByUserId, type Bot } from "../src/runner/store.js";

const USAGE = `Usage:
  npm run bot -- create <username> [--moderator]
  npm run bot -- token <username>
  npm run bot -- revoke <username>
  npm run bot -- limits <username> [--hour N] [--day N] [--default]
  npm run bot -- list

The runner:
  npm run bot -- config <username> [--model ID] [--mode tools|single_shot] [--effort default|none|minimal|low|medium|high|xhigh]
                 [--persona-file PATH|-] [--every MIN-MAX (minutes)] [--window HH:MM-HH:MM]
                 [--steps N] [--posts-per-day N] [--writes-per-wake N] [--lurk 0..1]
                 [--boards slug,slug|all] [--key-env VAR] [--token-env VAR]
  npm run bot -- show <username>
  npm run bot -- resume <username>
  npm run bot -- pause <username>
  npm run bot -- wake <username>
  npm run bot -- runs <username> [--limit N] [--run ID]

Memory:
  npm run bot -- standing <username> [--file PATH|-]
  npm run bot -- notes <username> [--about NAME] [--limit N]
  npm run bot -- compact <username>`;

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
      file: { type: "string" },
      about: { type: "string" },
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
        const set = parseSettings({
          model: values.model,
          mode: values.mode,
          effort: values.effort,
          persona: values["persona-file"] === undefined ? undefined : readFileSync(values["persona-file"] === "-" ? 0 : values["persona-file"], "utf-8"),
          every: values.every,
          window: values.window,
          steps: values.steps,
          postsPerDay: values["posts-per-day"],
          writesPerWake: values["writes-per-wake"],
          lurk: values.lurk,
          boards: values.boards,
          keyEnv: values["key-env"],
          tokenEnv: values["token-env"],
        });
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
        await applyColumns(pool, bot.id, set, "cli");
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
        await setActive(pool, bot.userId, active, "cli");
        console.log(active ? `${bot.username} will be woken; its first wake comes within its interval.` : `${bot.username} won't be woken until resumed.`);
        break;
      }
      case "wake": {
        const bot = await runnerBot(pool, (await findBot(username!)).id);
        if (!bot.active) fail(`${bot.username} is paused: npm run bot -- resume ${bot.username} first.`);
        await requestWake(pool, bot.userId);
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
      case "standing": {
        const bot = await runnerBot(pool, (await findBot(username!)).id);
        if (values.file !== undefined) {
          const text = readFileSync(values.file === "-" ? 0 : values.file, "utf-8");
          await writeStanding(pool, bot.userId, text, "admin", "cli");
        }
        const standing = await currentStanding(pool, bot.userId);
        console.log(standing ? `${bot.username}'s standing notes (version ${standing.id}, ${at(standing.createdAt)}):\n\n${standing.body}` : `${bot.username} has no standing notes yet.`);
        break;
      }
      case "notes": {
        const bot = await runnerBot(pool, (await findBot(username!)).id);
        const notes = await recallNotes(pool, bot.userId, "", values.about ?? "", count(values.limit, "limit") ?? 50);
        if (notes.length === 0) console.log(`${bot.username} has no notes${values.about ? ` about ${values.about}` : ""}.`);
        for (const n of notes) console.log(`#${n.id}${n.archivedAt ? " (folded)" : ""}  ${noteLine(n)}`);
        break;
      }
      case "compact": {
        const bot = await runnerBot(pool, (await findBot(username!)).id);
        if (!bot.active) fail(`${bot.username} is paused: npm run bot -- resume ${bot.username} first.`);
        await requestCompaction(pool, bot.userId);
        console.log(`${bot.username}'s notes are folded into its standing notes at the runner's next tick.`);
        break;
      }
      default:
        fail(USAGE);
    }
  } finally {
    await pool.end();
  }
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
    kind: string;
    trigger: string;
    outcome: string;
    model_calls: number;
    prompt_tokens: number;
    completion_tokens: number;
    writes: number;
    note: string | null;
    error: string | null;
  }>(
    `SELECT id, started_at, kind, trigger, outcome, model_calls, prompt_tokens, completion_tokens, writes, note, error
       FROM bots.runs WHERE user_id = $1 ORDER BY id DESC LIMIT $2`,
    [bot.userId, limit]
  );
  if (rows.length === 0) console.log(`${bot.username} hasn't been woken yet.`);
  for (const r of rows) {
    const tokens = r.model_calls ? `, ${r.model_calls} calls, ${r.prompt_tokens} in / ${r.completion_tokens} out` : "";
    const writes = r.writes ? `, ${r.writes} write(s)` : "";
    const text = r.error ?? r.note;
    console.log(`#${r.id}  ${r.started_at.toISOString()}  ${r.kind === "compaction" ? "compaction " : ""}${r.trigger}  ${r.outcome}${tokens}${writes}${text ? `\n      ${text.replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
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
