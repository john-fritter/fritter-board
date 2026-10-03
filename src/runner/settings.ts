import { config } from "../config.js";
import { BRIEF_NAMES, isBriefName } from "./briefs.js";
import { modelIdProblem } from "./model.js";
import { parseTimeOfDay } from "./schedule.js";
import type { Db } from "./store.js";

/**
 * Changing a bot's runner settings, persona, schedule state and standing
 * document: shared by `npm run bot` and the admin pages (src/botadmin/), which
 * both run as the board's role. The runner itself never calls these; its role
 * can only read bots.config.
 *
 * Every change to bots.config is logged in bots.config_log with who made it,
 * so it can be seen and undone.
 */

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

const fail = (message: string): never => {
  throw new SettingsError(message);
};

export const EFFORTS = ["default", "none", "minimal", "low", "medium", "high", "xhigh"] as const;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** Settings as text, the way the CLI's flags and the admin form both give them. */
export interface SettingsInput {
  model?: string;
  /** Fallback models, in order: "a,b", or "none". */
  fallbacks?: string;
  mode?: string;
  effort?: string;
  persona?: string;
  /** Minutes between wakes: "120-300", or one number. */
  every?: string;
  /** "08:00-24:00". */
  window?: string;
  steps?: string;
  postsPerDay?: string;
  writesPerWake?: string;
  lurk?: string;
  /** Board slugs, "a,b", or "all". */
  boards?: string;
  keyEnv?: string;
  tokenEnv?: string;
  /** Model calls a day on the member key: a number, or "default". */
  callsPerDay?: string;
  /** Moderation rounds: "on" or "off". */
  moderates?: string;
  modKeyEnv?: string;
  modEffort?: string;
  modSteps?: string;
}

/** The bots.config columns that settings may change. */
export const CONFIG_COLUMNS = [
  "active",
  "model",
  "fallback_models",
  "mode",
  "reasoning_effort",
  "persona_prompt",
  "interval_min_minutes",
  "interval_max_minutes",
  "window_start",
  "window_end",
  "max_steps",
  "posts_per_day",
  "max_writes_per_wake",
  "lurk_bias",
  "write_boards",
  "api_key_ref",
  "board_token_ref",
  "model_calls_per_day",
  "moderates",
  "mod_api_key_ref",
  "mod_reasoning_effort",
  "mod_max_steps",
] as const;
export type ConfigColumn = (typeof CONFIG_COLUMNS)[number];

function whole(raw: string | undefined, what: string, min: number): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw.trim())) fail(`${what} takes a whole number.`);
  const n = Number(raw.trim());
  if (n < min) fail(`${what} must be at least ${min}.`);
  return n;
}

/** The bots.config columns to set, from settings given as text. Throws SettingsError. */
export function parseSettings(v: SettingsInput): Partial<Record<ConfigColumn, unknown>> {
  const out: Partial<Record<ConfigColumn, unknown>> = {};
  if (v.model !== undefined) {
    const problem = modelIdProblem(v.model);
    if (problem) fail(problem);
    out.model = v.model.trim();
  }
  if (v.fallbacks !== undefined) {
    const raw = v.fallbacks.trim();
    const models = raw === "none" ? [] : raw.split(",").map((m) => m.trim()).filter(Boolean);
    for (const m of models) {
      const problem = modelIdProblem(m);
      if (problem) fail(problem);
    }
    if (raw !== "" && raw !== "none" && models.length === 0) fail("The fallbacks are model ids (a,b), or none.");
    out.fallback_models = [...new Set(models)];
  }
  if (v.mode !== undefined) {
    if (v.mode !== "tools" && v.mode !== "single_shot") fail("The mode is tools or single_shot.");
    out.mode = v.mode;
  }
  if (v.effort !== undefined) {
    if (!(EFFORTS as readonly string[]).includes(v.effort)) fail(`The reasoning effort is one of ${EFFORTS.join(", ")}.`);
    out.reasoning_effort = v.effort;
  }
  if (v.persona !== undefined) {
    const text = v.persona.replace(/\r\n/g, "\n").trim();
    if (!text) fail("The persona is empty.");
    out.persona_prompt = text;
  }
  if (v.every !== undefined) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(v.every.trim()) ?? fail("The interval is minutes, like 120-300.");
    const lo = Number(m[1]);
    const hi = Number(m[2] ?? m[1]);
    if (lo <= 0 || hi < lo) fail("The interval needs 0 < MIN <= MAX.");
    out.interval_min_minutes = lo;
    out.interval_max_minutes = hi;
  }
  if (v.window !== undefined) {
    const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(v.window.trim()) ?? fail("The waking window is like 08:00-24:00.");
    for (const t of [m[1]!, m[2]!]) {
      try {
        parseTimeOfDay(t);
      } catch {
        fail(`${t} isn't a time of day.`);
      }
    }
    out.window_start = m[1] === "24:00" ? "00:00" : m[1];
    out.window_end = m[2] === "24:00" ? "00:00" : m[2];
  }
  const steps = whole(v.steps, "Steps", 1);
  if (steps !== undefined) out.max_steps = steps;
  const perDay = whole(v.postsPerDay, "Posts per day", 0);
  if (perDay !== undefined) out.posts_per_day = perDay;
  const perWake = whole(v.writesPerWake, "Writes per wake", 0);
  if (perWake !== undefined) out.max_writes_per_wake = perWake;
  if (v.lurk !== undefined) {
    const n = Number(v.lurk.trim());
    if (v.lurk.trim() === "" || !(n >= 0 && n <= 1)) fail("Lurk is a number from 0 to 1.");
    out.lurk_bias = n;
  }
  if (v.boards !== undefined) {
    const slugs = v.boards.split(",").map((b) => b.trim()).filter(Boolean);
    out.write_boards = v.boards.trim() === "all" ? null : slugs.length ? slugs : fail("The boards are slugs (a,b), or all.");
  }
  for (const [value, column, what] of [
    [v.keyEnv, "api_key_ref", "The key's"],
    [v.tokenEnv, "board_token_ref", "The token's"],
  ] as const) {
    if (value === undefined) continue;
    if (!ENV_NAME.test(value.trim())) fail(`${what} is an environment variable name, like NANOGPT_KEY_TESTBOT.`);
    out[column] = value.trim();
  }
  if (v.callsPerDay !== undefined) {
    out.model_calls_per_day = v.callsPerDay.trim() === "default" || v.callsPerDay.trim() === "" ? null : whole(v.callsPerDay, "Calls per day", 0);
  }
  if (v.moderates !== undefined) {
    const on = v.moderates.trim();
    if (on !== "on" && on !== "off") fail("Moderation is on or off.");
    out.moderates = on === "on";
  }
  if (v.modKeyEnv !== undefined) {
    const name = v.modKeyEnv.trim();
    if (name !== "" && !ENV_NAME.test(name)) fail("The moderation key's is an environment variable name, like NANOGPT_KEY_MODERATION.");
    out.mod_api_key_ref = name || null;
  }
  if (v.modEffort !== undefined) {
    if (!(EFFORTS as readonly string[]).includes(v.modEffort)) fail(`The moderation effort is one of ${EFFORTS.join(", ")}.`);
    out.mod_reasoning_effort = v.modEffort;
  }
  const modSteps = whole(v.modSteps, "Moderation steps", 1);
  if (modSteps !== undefined) out.mod_max_steps = modSteps;
  return out;
}

/** A bot's settings as the text parseSettings reads, to fill a form. */
export function settingsText(c: Record<string, unknown>): Required<SettingsInput> {
  const hhmm = (t: unknown) => String(t).slice(0, 5);
  const end = hhmm(c["window_end"]);
  return {
    model: String(c["model"]),
    fallbacks: Array.isArray(c["fallback_models"]) && c["fallback_models"].length ? (c["fallback_models"] as string[]).join(",") : "none",
    mode: String(c["mode"]),
    effort: String(c["reasoning_effort"]),
    persona: String(c["persona_prompt"] ?? ""),
    every: `${c["interval_min_minutes"]}-${c["interval_max_minutes"]}`,
    window: `${hhmm(c["window_start"])}-${end === "00:00" ? "24:00" : end}`,
    steps: String(c["max_steps"]),
    postsPerDay: String(c["posts_per_day"]),
    writesPerWake: String(c["max_writes_per_wake"]),
    lurk: String(c["lurk_bias"]),
    boards: Array.isArray(c["write_boards"]) ? (c["write_boards"] as string[]).join(",") : "all",
    keyEnv: String(c["api_key_ref"]),
    tokenEnv: String(c["board_token_ref"]),
    callsPerDay: c["model_calls_per_day"] === null || c["model_calls_per_day"] === undefined ? "default" : String(c["model_calls_per_day"]),
    moderates: c["moderates"] === true ? "on" : "off",
    modKeyEnv: c["mod_api_key_ref"] ? String(c["mod_api_key_ref"]) : "",
    modEffort: String(c["mod_reasoning_effort"] ?? "medium"),
    modSteps: String(c["mod_max_steps"] ?? 8),
  };
}

export type ConfigChanges = Record<string, { from: unknown; to: unknown }>;

/**
 * Sets bots.config columns and logs what actually changed. A new interval or
 * window starts the bot's schedule afresh at the runner's next tick. Returns
 * the changes (empty when nothing changed).
 */
export async function applyColumns(
  db: Db,
  userId: number,
  set: Partial<Record<ConfigColumn, unknown>>,
  changedBy: string
): Promise<ConfigChanges> {
  const fields = (Object.keys(set) as ConfigColumn[]).filter((f) => (CONFIG_COLUMNS as readonly string[]).includes(f));
  if (fields.length === 0) return {};
  // The FROM subquery reads the row as it was before this statement's update.
  const { rows } = await db.query<{ before: Record<string, unknown>; after: Record<string, unknown> }>(
    `WITH old AS (SELECT * FROM bots.config WHERE user_id = $1),
          upd AS (
            UPDATE bots.config SET ${fields.map((f, i) => `${f} = $${i + 2}`).join(", ")}, updated_at = NOW()
             WHERE user_id = $1 RETURNING *
          )
     SELECT row_to_json(old) AS before, row_to_json(upd) AS after FROM old, upd`,
    [userId, ...fields.map((f) => set[f])]
  );
  const row = rows[0];
  if (!row) throw new SettingsError("That bot has no runner settings.");
  const changes: ConfigChanges = {};
  for (const f of fields) {
    if (JSON.stringify(row.before[f]) !== JSON.stringify(row.after[f])) changes[f] = { from: row.before[f], to: row.after[f] };
  }
  if (Object.keys(changes).length === 0) return changes;
  await db.query("INSERT INTO bots.config_log (user_id, changed_by, changes) VALUES ($1, $2, $3)", [
    userId,
    changedBy,
    JSON.stringify(changes),
  ]);
  const rescheduled = ["interval_min_minutes", "interval_max_minutes", "window_start", "window_end"].some((f) => f in changes);
  if (rescheduled) {
    await db.query("UPDATE bots.state SET next_wake_at = NULL, updated_at = NOW() WHERE user_id = $1", [userId]);
  }
  // Moderation turned on, or off, or onto another key: its rounds start afresh.
  if ("moderates" in changes || "mod_api_key_ref" in changes) {
    await db.query(
      "UPDATE bots.state SET mod_next_at = NULL, mod_early_at = NULL, mod_early_trigger = NULL, mod_paused_until = NULL, updated_at = NOW() WHERE user_id = $1",
      [userId]
    );
  }
  return changes;
}

/** Undoes a logged change: sets each column it changed back to what it was. */
export async function revertChange(db: Db, userId: number, entryId: number, changedBy: string): Promise<ConfigChanges> {
  const { rows } = await db.query<{ changes: ConfigChanges }>("SELECT changes FROM bots.config_log WHERE id = $1 AND user_id = $2", [
    entryId,
    userId,
  ]);
  const entry = rows[0] ?? fail("There's no such change.");
  const set: Partial<Record<ConfigColumn, unknown>> = {};
  for (const [column, change] of Object.entries(entry.changes)) {
    if ((CONFIG_COLUMNS as readonly string[]).includes(column)) set[column as ConfigColumn] = change.from;
  }
  // Resuming or pausing goes through setActive, which also resets the schedule.
  if ("active" in set) {
    const active = set.active === true;
    delete set.active;
    const changes = await applyColumns(db, userId, set, changedBy);
    return { ...changes, ...(await setActive(db, userId, active, changedBy)) };
  }
  return applyColumns(db, userId, set, changedBy);
}

/**
 * Resumes or pauses a bot. Either way its schedules (visits and moderation
 * rounds) start afresh; resuming also lifts a pause for NanoGPT's daily cap.
 */
export async function setActive(db: Db, userId: number, active: boolean, changedBy: string): Promise<ConfigChanges> {
  const changes = await applyColumns(db, userId, { active }, changedBy);
  await db.query(
    `UPDATE bots.state SET next_wake_at = NULL, early_wake_at = NULL, early_wake_trigger = NULL,
            paused_until = CASE WHEN $2 THEN NULL ELSE paused_until END,
            mod_next_at = NULL, mod_early_at = NULL, mod_early_trigger = NULL,
            mod_paused_until = CASE WHEN $2 THEN NULL ELSE mod_paused_until END, updated_at = NOW()
      WHERE user_id = $1`,
    [userId, active]
  );
  return changes;
}

/** Wakes an active bot at the runner's next tick, whatever its window. */
export async function requestWake(db: Db, userId: number): Promise<void> {
  await db.query(
    "UPDATE bots.state SET early_wake_at = NOW(), early_wake_trigger = 'manual', paused_until = NULL, updated_at = NOW() WHERE user_id = $1",
    [userId]
  );
}

/** A moderation round for an active bot that moderates, at the runner's next tick. */
export async function requestModeration(db: Db, userId: number): Promise<void> {
  await db.query(
    "UPDATE bots.state SET mod_early_at = NOW(), mod_early_trigger = 'manual', mod_paused_until = NULL, updated_at = NOW() WHERE user_id = $1",
    [userId]
  );
}

/** Compacts an active bot's notes at the runner's next tick: every unarchived note is folded. */
export async function requestCompaction(db: Db, userId: number): Promise<void> {
  await db.query("UPDATE bots.state SET compact_requested_at = NOW(), updated_at = NOW() WHERE user_id = $1", [userId]);
}

/** A new version of a bot's standing document, written by hand or restored from an old one. */
export async function writeStanding(
  db: Db,
  userId: number,
  body: string,
  source: "admin" | "rollback",
  createdBy: string
): Promise<number> {
  const text = body.replace(/\r\n/g, "\n").trim();
  if (text.length > config.runner.standing_max_chars) {
    fail(`The standing notes are ${text.length} characters; the limit is ${config.runner.standing_max_chars}.`);
  }
  const { rows } = await db.query<{ id: number }>(
    "INSERT INTO bots.standing_versions (user_id, body, source, created_by) VALUES ($1, $2, $3, $4) RETURNING id",
    [userId, text, source, createdBy]
  );
  return rows[0]!.id;
}

/** A new version of a role brief (./briefs.ts), written by hand or restored from an old one. */
export async function writeBrief(db: Db, name: string, body: string, createdBy: string): Promise<number> {
  if (!isBriefName(name)) fail(`There's no brief called ${name}; they are ${BRIEF_NAMES.join(", ")}.`);
  const text = body.replace(/\r\n/g, "\n").trim();
  if (!text) fail("The brief is empty.");
  const { rows } = await db.query<{ id: number }>(
    "INSERT INTO bots.brief_versions (name, body, created_by) VALUES ($1, $2, $3) RETURNING id",
    [name, text, createdBy]
  );
  return rows[0]!.id;
}
