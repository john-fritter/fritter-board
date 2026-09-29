import pg, { Pool } from "pg";
import { config } from "../config.js";
import type { ReasoningEffort } from "./model.js";
import { parseTimeOfDay, type ScheduleSettings } from "./schedule.js";

/**
 * The runner's tables, in the `bots` schema. The runner connects as its own
 * role (RUNNER_DATABASE_URL), which has this schema and nothing of the
 * board's. Queries name the schema, so `npm run bot`, which runs as the
 * board's role, can use them too.
 */

pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export function createRunnerPool(url: string): Pool {
  return new Pool({ connectionString: url, max: 3, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
}

export type Db = Pick<Pool, "query">;
export type Trigger = "schedule" | "early" | "manual";
export type Outcome = "done" | "lurked" | "skipped" | "failed";
export type RunKind = "wake" | "compaction" | "moderation";

export interface Bot {
  userId: number;
  username: string;
  active: boolean;
  model: string;
  reasoningEffort: ReasoningEffort;
  mode: "tools" | "single_shot";
  personaPrompt: string;
  schedule: ScheduleSettings;
  maxSteps: number;
  postsPerDay: number;
  maxWritesPerWake: number;
  lurkBias: number;
  writeBoards: string[] | null;
  apiKeyRef: string;
  boardTokenRef: string;
  /** Model calls a day on the member key; null is runner.model_calls_per_day. */
  modelCallsPerDay: number | null;
  // Moderation cycles, for a bot that moderates.
  moderates: boolean;
  modApiKeyRef: string | null;
  modReasoningEffort: ReasoningEffort;
  modMaxSteps: number;
  // State
  nextWakeAt: Date | null;
  earlyWakeAt: Date | null;
  earlyWakeTrigger: "early" | "manual" | null;
  inboxCursor: Date | null;
  pausedUntil: Date | null;
  compactRequestedAt: Date | null;
  modNextAt: Date | null;
  modEarlyAt: Date | null;
  modEarlyTrigger: "early" | "manual" | null;
  modCursor: Date | null;
  modPausedUntil: Date | null;
}

interface BotRow {
  user_id: number;
  username: string;
  active: boolean;
  model: string;
  reasoning_effort: ReasoningEffort;
  mode: "tools" | "single_shot";
  persona_prompt: string;
  interval_min_minutes: number;
  interval_max_minutes: number;
  window_start: string;
  window_end: string;
  max_steps: number;
  posts_per_day: number;
  max_writes_per_wake: number;
  lurk_bias: number;
  write_boards: string[] | null;
  api_key_ref: string;
  board_token_ref: string;
  model_calls_per_day: number | null;
  moderates: boolean;
  mod_api_key_ref: string | null;
  mod_reasoning_effort: ReasoningEffort;
  mod_max_steps: number;
  next_wake_at: Date | null;
  early_wake_at: Date | null;
  early_wake_trigger: "early" | "manual" | null;
  inbox_cursor: Date | null;
  paused_until: Date | null;
  compact_requested_at: Date | null;
  mod_next_at: Date | null;
  mod_early_at: Date | null;
  mod_early_trigger: "early" | "manual" | null;
  mod_cursor: Date | null;
  mod_paused_until: Date | null;
}

const BOT_SQL = `
  SELECT c.*, s.next_wake_at, s.early_wake_at, s.early_wake_trigger, s.inbox_cursor, s.paused_until,
         s.compact_requested_at, s.mod_next_at, s.mod_early_at, s.mod_early_trigger, s.mod_cursor,
         s.mod_paused_until
    FROM bots.config c
    LEFT JOIN bots.state s ON s.user_id = c.user_id`;

function toBot(r: BotRow): Bot {
  return {
    userId: r.user_id,
    username: r.username,
    active: r.active,
    model: r.model,
    reasoningEffort: r.reasoning_effort,
    mode: r.mode,
    personaPrompt: r.persona_prompt,
    schedule: {
      intervalMin: r.interval_min_minutes,
      intervalMax: r.interval_max_minutes,
      start: parseTimeOfDay(r.window_start),
      end: parseTimeOfDay(r.window_end),
    },
    maxSteps: r.max_steps,
    postsPerDay: r.posts_per_day,
    maxWritesPerWake: r.max_writes_per_wake,
    lurkBias: r.lurk_bias,
    writeBoards: r.write_boards,
    apiKeyRef: r.api_key_ref,
    boardTokenRef: r.board_token_ref,
    modelCallsPerDay: r.model_calls_per_day,
    moderates: r.moderates,
    modApiKeyRef: r.mod_api_key_ref,
    modReasoningEffort: r.mod_reasoning_effort,
    modMaxSteps: r.mod_max_steps,
    nextWakeAt: r.next_wake_at,
    earlyWakeAt: r.early_wake_at,
    earlyWakeTrigger: r.early_wake_trigger,
    inboxCursor: r.inbox_cursor,
    pausedUntil: r.paused_until,
    compactRequestedAt: r.compact_requested_at,
    modNextAt: r.mod_next_at,
    modEarlyAt: r.mod_early_at,
    modEarlyTrigger: r.mod_early_trigger,
    modCursor: r.mod_cursor,
    modPausedUntil: r.mod_paused_until,
  };
}

export async function activeBots(db: Db): Promise<Bot[]> {
  const { rows } = await db.query<BotRow>(`${BOT_SQL} WHERE c.active ORDER BY c.user_id`);
  return rows.map(toBot);
}

export async function allBots(db: Db): Promise<Bot[]> {
  const { rows } = await db.query<BotRow>(`${BOT_SQL} ORDER BY c.user_id`);
  return rows.map(toBot);
}

export async function botByUserId(db: Db, userId: number): Promise<Bot | null> {
  const { rows } = await db.query<BotRow>(`${BOT_SQL} WHERE c.user_id = $1`, [userId]);
  return rows[0] ? toBot(rows[0]) : null;
}

export async function botByUsername(db: Db, username: string): Promise<Bot | null> {
  const { rows } = await db.query<BotRow>(`${BOT_SQL} WHERE LOWER(c.username) = LOWER($1)`, [username.trim()]);
  return rows[0] ? toBot(rows[0]) : null;
}

export interface StatePatch {
  nextWakeAt?: Date | null;
  earlyWakeAt?: Date | null;
  earlyWakeTrigger?: "early" | "manual" | null;
  inboxCursor?: Date | null;
  pausedUntil?: Date | null;
  compactRequestedAt?: Date | null;
  modNextAt?: Date | null;
  modEarlyAt?: Date | null;
  modEarlyTrigger?: "early" | "manual" | null;
  modCursor?: Date | null;
  modPausedUntil?: Date | null;
}

const STATE_COLUMNS: Record<keyof StatePatch, string> = {
  nextWakeAt: "next_wake_at",
  earlyWakeAt: "early_wake_at",
  earlyWakeTrigger: "early_wake_trigger",
  inboxCursor: "inbox_cursor",
  pausedUntil: "paused_until",
  compactRequestedAt: "compact_requested_at",
  modNextAt: "mod_next_at",
  modEarlyAt: "mod_early_at",
  modEarlyTrigger: "mod_early_trigger",
  modCursor: "mod_cursor",
  modPausedUntil: "mod_paused_until",
};

/** Updates a bot's schedule state; fields left out are unchanged. */
export async function updateState(db: Db, userId: number, patch: StatePatch): Promise<void> {
  const keys = (Object.keys(patch) as (keyof StatePatch)[]).filter((k) => patch[k] !== undefined);
  if (keys.length === 0) return;
  const sets = keys.map((k, i) => `${STATE_COLUMNS[k]} = $${i + 2}`);
  await db.query(`UPDATE bots.state SET ${sets.join(", ")}, updated_at = NOW() WHERE user_id = $1`, [
    userId,
    ...keys.map((k) => patch[k]),
  ]);
}

export async function startRun(db: Db, bot: Bot, trigger: Trigger, kind: RunKind = "wake"): Promise<number> {
  // Moderation cycles always use tools, at their own effort.
  const moderation = kind === "moderation";
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO bots.runs (user_id, kind, trigger, mode, model, reasoning_effort)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [bot.userId, kind, trigger, moderation ? "tools" : bot.mode, bot.model, moderation ? bot.modReasoningEffort : bot.reasoningEffort]
  );
  return rows[0]!.id;
}

export interface Action {
  tool: string;
  args: string;
  ok: boolean;
  result: string;
}

export interface RunRecord {
  outcome: Outcome;
  inboxSince?: Date | null;
  inboxUntil?: Date | null;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  writes: number;
  actions: Action[];
  note?: string | null;
  error?: string | null;
  prefixHash?: string | null;
  transcript?: unknown[] | null;
  /** Calls to the summary model this wake made for long threads. */
  summary?: SummaryUsage;
}

export interface SummaryUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
}

export async function finishRun(db: Db, runId: number, r: RunRecord): Promise<void> {
  await db.query(
    `UPDATE bots.runs SET outcome = $2, finished_at = NOW(), inbox_since = $3, inbox_until = $4,
            model_calls = $5, prompt_tokens = $6, completion_tokens = $7, reasoning_tokens = $8,
            cached_tokens = $9, writes = $10, actions = $11, note = $12, error = $13, prefix_hash = $14,
            transcript = $15, summary_calls = $16, summary_prompt_tokens = $17, summary_completion_tokens = $18
      WHERE id = $1`,
    [
      runId,
      r.outcome,
      r.inboxSince ?? null,
      r.inboxUntil ?? null,
      r.modelCalls,
      r.promptTokens,
      r.completionTokens,
      r.reasoningTokens,
      r.cachedTokens,
      r.writes,
      JSON.stringify(r.actions),
      r.note ?? null,
      r.error ?? null,
      r.prefixHash ?? null,
      r.transcript ? JSON.stringify(r.transcript) : null,
      r.summary?.calls ?? 0,
      r.summary?.promptTokens ?? 0,
      r.summary?.completionTokens ?? 0,
    ]
  );
}

/** Writes the runner made for a bot in the last 24 hours: its own pacing count. */
export async function writesLastDay(db: Db, userId: number): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT COALESCE(SUM(writes), 0)::int AS n FROM bots.runs
      WHERE user_id = $1 AND kind = 'wake' AND started_at > NOW() - INTERVAL '1 day'`,
    [userId]
  );
  return rows[0]!.n;
}

/** Early wakes (or early moderation cycles) in the last 24 hours, for the daily cap. */
export async function earlyWakesLastDay(db: Db, userId: number, kind: "wake" | "moderation" = "wake"): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM bots.runs
      WHERE user_id = $1 AND kind = $2 AND trigger = 'early' AND started_at > NOW() - INTERVAL '1 day'`,
    [userId, kind]
  );
  return rows[0]!.n;
}

/**
 * The bot's model calls in the last 24 hours on one of its keys: its member
 * key (visits and compaction) or its moderation key (moderation cycles).
 */
export async function modelCallsLastDay(db: Db, userId: number, key: "member" | "moderation"): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT COALESCE(SUM(model_calls), 0)::int AS n FROM bots.runs
      WHERE user_id = $1 AND started_at > NOW() - INTERVAL '1 day'
        AND (kind = 'moderation') = $2`,
    [userId, key === "moderation"]
  );
  return rows[0]!.n;
}

/** When the bot's last moderation cycle started. */
export async function lastModerationAt(db: Db, userId: number): Promise<Date | null> {
  const { rows } = await db.query<{ at: Date | null }>(
    "SELECT MAX(started_at) AS at FROM bots.runs WHERE user_id = $1 AND kind = 'moderation'",
    [userId]
  );
  return rows[0]!.at;
}

/**
 * A NanoGPT key reached its daily cap: every bot using it, as its member key
 * or its moderation key, pauses that use until the reset. Returns how many
 * bots were paused.
 */
export async function pauseKey(db: Db, keyRef: string, until: Date): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE bots.state s
        SET paused_until = CASE WHEN c.api_key_ref = $1 THEN GREATEST(COALESCE(s.paused_until, $2), $2) ELSE s.paused_until END,
            mod_paused_until = CASE WHEN c.mod_api_key_ref = $1 THEN GREATEST(COALESCE(s.mod_paused_until, $2), $2) ELSE s.mod_paused_until END,
            updated_at = NOW()
       FROM bots.config c
      WHERE c.user_id = s.user_id AND (c.api_key_ref = $1 OR c.mod_api_key_ref = $1)`,
    [keyRef, until]
  );
  return rowCount ?? 0;
}

/** Runs left 'running' by a runner that stopped mid-wake. */
export async function failAbandonedRuns(db: Db): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE bots.runs SET outcome = 'failed', finished_at = NOW(), error = 'The runner stopped during this wake.'
      WHERE outcome = 'running'`
  );
  return rowCount ?? 0;
}

/** Clears transcripts past their retention. The rest of the run log stays. */
export async function pruneTranscripts(db: Db): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE bots.runs SET transcript = NULL
      WHERE transcript IS NOT NULL AND started_at < NOW() - $1::float8 * INTERVAL '1 day'`,
    [config.runner.transcript_retention_days]
  );
  return rowCount ?? 0;
}

/** Holds a session-level advisory lock, so only one runner is ever active. */
export const RUNNER_LOCK_KEY = 5_172_000_501;

/** A run that didn't happen, and why: logged so the admin pages show it. */
export async function recordSkip(db: Db, bot: Bot, trigger: Trigger, kind: RunKind, note: string): Promise<number> {
  const runId = await startRun(db, bot, trigger, kind);
  await finishRun(db, runId, {
    outcome: "skipped",
    modelCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    writes: 0,
    actions: [],
    note,
  });
  return runId;
}
