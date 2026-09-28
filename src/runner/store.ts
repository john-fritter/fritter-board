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
export type RunKind = "wake" | "compaction";

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
  // State
  nextWakeAt: Date | null;
  earlyWakeAt: Date | null;
  earlyWakeTrigger: "early" | "manual" | null;
  inboxCursor: Date | null;
  pausedUntil: Date | null;
  compactRequestedAt: Date | null;
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
  next_wake_at: Date | null;
  early_wake_at: Date | null;
  early_wake_trigger: "early" | "manual" | null;
  inbox_cursor: Date | null;
  paused_until: Date | null;
  compact_requested_at: Date | null;
}

const BOT_SQL = `
  SELECT c.*, s.next_wake_at, s.early_wake_at, s.early_wake_trigger, s.inbox_cursor, s.paused_until,
         s.compact_requested_at
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
    nextWakeAt: r.next_wake_at,
    earlyWakeAt: r.early_wake_at,
    earlyWakeTrigger: r.early_wake_trigger,
    inboxCursor: r.inbox_cursor,
    pausedUntil: r.paused_until,
    compactRequestedAt: r.compact_requested_at,
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

export interface StatePatch {
  nextWakeAt?: Date | null;
  earlyWakeAt?: Date | null;
  earlyWakeTrigger?: "early" | "manual" | null;
  inboxCursor?: Date | null;
  pausedUntil?: Date | null;
  compactRequestedAt?: Date | null;
}

const STATE_COLUMNS: Record<keyof StatePatch, string> = {
  nextWakeAt: "next_wake_at",
  earlyWakeAt: "early_wake_at",
  earlyWakeTrigger: "early_wake_trigger",
  inboxCursor: "inbox_cursor",
  pausedUntil: "paused_until",
  compactRequestedAt: "compact_requested_at",
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
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO bots.runs (user_id, kind, trigger, mode, model, reasoning_effort)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [bot.userId, kind, trigger, bot.mode, bot.model, bot.reasoningEffort]
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

/** Early wakes in the last 24 hours, for the daily cap. */
export async function earlyWakesLastDay(db: Db, userId: number): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM bots.runs
      WHERE user_id = $1 AND trigger = 'early' AND started_at > NOW() - INTERVAL '1 day'`,
    [userId]
  );
  return rows[0]!.n;
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
