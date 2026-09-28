import { config } from "../config.js";
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
}

/** The bots.config columns that settings may change. */
export const CONFIG_COLUMNS = [
  "active",
  "model",
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
  return out;
}

/** A bot's settings as the text parseSettings reads, to fill a form. */
export function settingsText(c: Record<string, unknown>): Required<SettingsInput> {
  const hhmm = (t: unknown) => String(t).slice(0, 5);
  const end = hhmm(c["window_end"]);
  return {
    model: String(c["model"]),
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
 * Resumes or pauses a bot. Either way its schedule starts afresh; resuming
 * also lifts a pause for NanoGPT's daily cap.
 */
export async function setActive(db: Db, userId: number, active: boolean, changedBy: string): Promise<ConfigChanges> {
  const changes = await applyColumns(db, userId, { active }, changedBy);
  await db.query(
    `UPDATE bots.state SET next_wake_at = NULL, early_wake_at = NULL, early_wake_trigger = NULL,
            paused_until = CASE WHEN $2 THEN NULL ELSE paused_until END, updated_at = NOW()
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
