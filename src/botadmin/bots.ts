import { config } from "../config.js";
import { invalid, notFound } from "../forum/errors.js";
import { asAdmin } from "../forum/permissions.js";
import type { Viewer } from "../forum/types.js";
import { paginate, type Page } from "../lib/pagination.js";
import { currentStanding, type Note, type Standing } from "../runner/memory.js";
import {
  applyColumns,
  parseSettings,
  requestCompaction,
  requestModeration,
  requestWake,
  revertChange,
  setActive,
  settingsText,
  SettingsError,
  writeBrief,
  writeStanding,
  type ConfigChanges,
  type SettingsInput,
} from "../runner/settings.js";
import { BRIEF_NAMES, briefVersions, currentBriefs, defaultBriefs, isBriefName, type BriefName, type BriefVersion } from "../runner/briefs.js";
import { botByUsername, modelCallsLastDay, runSearches, writesLastDay, type Bot, type Db, type SearchRow } from "../runner/store.js";

/**
 * The admin's steering wheel for bots (/admin/bots): what each bot is doing,
 * its runs and transcripts, its settings and persona, its standing document
 * and notes. Admin only: every function here checks the viewer itself, and
 * anyone else gets a 404, as with the rest of /admin. It reads the runner's
 * `bots` schema with the web app's own role, which owns it; src/forum/ never
 * imports this module.
 *
 * Transcripts carry Back Room posts and private messages, which the admin
 * can read on the board anyway.
 */

export interface BotAdminCtx {
  pool: Db;
}

function admin(viewer: Viewer | null): Viewer {
  if (!asAdmin(viewer)) throw notFound();
  return viewer;
}

async function findBot(ctx: BotAdminCtx, viewer: Viewer | null, name: string): Promise<Bot> {
  admin(viewer);
  return (await botByUsername(ctx.pool, name)) ?? fail404();
}

const fail404 = (): never => {
  throw notFound();
};

/** Settings errors are the admin's to fix on the form. */
async function settingsCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SettingsError) throw invalid(err.message);
    throw err;
  }
}

// ── Runs ───────────────────────────────────────────────────────────────────

export interface RunRow {
  id: number;
  kind: "wake" | "compaction" | "moderation";
  trigger: string;
  outcome: string;
  startedAt: Date;
  finishedAt: Date | null;
  model: string;
  /** The fallback the run ended on, when the bot's own model kept failing. */
  fallbackModel: string | null;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  summaryCalls: number;
  writes: number;
  note: string | null;
  error: string | null;
}

export interface Action {
  tool: string;
  args: string;
  ok: boolean;
  result: string;
}

/** A message of a transcript, as the runner stored it. */
export interface TranscriptMessage {
  role: string;
  content?: string | null;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface RunDetail extends RunRow {
  mode: string;
  reasoningEffort: string;
  reasoningTokens: number;
  summaryPromptTokens: number;
  summaryCompletionTokens: number;
  inboxSince: Date | null;
  inboxUntil: Date | null;
  actions: Action[];
  prefixHash: string | null;
  transcript: TranscriptMessage[] | null;
  /** The run's web searches, with the pages found: the URLs the bot never saw. */
  searches: (SearchRow & { createdAt: Date })[];
}

const RUN_COLUMNS = `id, kind, trigger, outcome, started_at, finished_at, model, fallback_model, model_calls, prompt_tokens,
  completion_tokens, cached_tokens, summary_calls, writes, note, error`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toRun = (r: any): RunRow => ({
  id: r.id,
  kind: r.kind,
  trigger: r.trigger,
  outcome: r.outcome,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  model: r.model,
  fallbackModel: r.fallback_model,
  modelCalls: r.model_calls,
  promptTokens: r.prompt_tokens,
  completionTokens: r.completion_tokens,
  cachedTokens: r.cached_tokens,
  summaryCalls: r.summary_calls,
  writes: r.writes,
  note: r.note,
  error: r.error,
});

async function recentRuns(db: Db, userId: number, limit: number, offset = 0): Promise<RunRow[]> {
  const { rows } = await db.query(`SELECT ${RUN_COLUMNS} FROM bots.runs WHERE user_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3`, [
    userId,
    limit,
    offset,
  ]);
  return rows.map(toRun);
}

export async function listRuns(ctx: BotAdminCtx, viewer: Viewer | null, name: string, rawPage: string | undefined) {
  const bot = await findBot(ctx, viewer, name);
  const { rows } = await ctx.pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM bots.runs WHERE user_id = $1", [bot.userId]);
  const page = paginate(rawPage, rows[0]!.n, config.pagination.bot_runs_per_page);
  return { bot, page, runs: await recentRuns(ctx.pool, bot.userId, page.perPage, page.offset) };
}

export async function getRun(ctx: BotAdminCtx, viewer: Viewer | null, name: string, runId: number) {
  const bot = await findBot(ctx, viewer, name);
  const { rows } = await ctx.pool.query("SELECT * FROM bots.runs WHERE id = $1 AND user_id = $2", [runId, bot.userId]);
  const r = rows[0] ?? fail404();
  const run: RunDetail = {
    ...toRun(r),
    mode: r.mode,
    reasoningEffort: r.reasoning_effort,
    reasoningTokens: r.reasoning_tokens,
    summaryPromptTokens: r.summary_prompt_tokens,
    summaryCompletionTokens: r.summary_completion_tokens,
    inboxSince: r.inbox_since,
    inboxUntil: r.inbox_until,
    actions: r.actions ?? [],
    prefixHash: r.prefix_hash,
    transcript: r.transcript,
    searches: await runSearches(ctx.pool, runId),
  };
  return { bot, run };
}

// ── The list, and one bot ──────────────────────────────────────────────────

export interface BotRow {
  bot: Bot;
  lastRun: RunRow | null;
  writesToday: number;
  notes: number;
  /** Model calls in the last 24 hours on its member key, and in moderation rounds. */
  callsToday: number;
  modCallsToday: number;
}

async function botRow(db: Db, bot: Bot): Promise<BotRow> {
  const [runs, writesToday, notes, callsToday, modCallsToday] = await Promise.all([
    recentRuns(db, bot.userId, 1),
    writesLastDay(db, bot.userId),
    db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM bots.notes WHERE user_id = $1 AND archived_at IS NULL", [bot.userId]),
    modelCallsLastDay(db, bot.userId, "member"),
    modelCallsLastDay(db, bot.userId, "moderation"),
  ]);
  return { bot, lastRun: runs[0] ?? null, writesToday, notes: notes.rows[0]!.n, callsToday, modCallsToday };
}

export async function listBots(ctx: BotAdminCtx, viewer: Viewer | null) {
  admin(viewer);
  const { rows } = await ctx.pool.query<{ username: string }>("SELECT username FROM bots.config ORDER BY user_id");
  const bots: BotRow[] = [];
  for (const r of rows) bots.push(await botRow(ctx.pool, (await botByUsername(ctx.pool, r.username))!));
  // Bot accounts the runner has no settings for yet (the CLI makes them, with their secrets' names).
  const unconfigured = await ctx.pool.query<{ username: string }>(
    `SELECT u.username FROM users u
      WHERE u.is_bot AND u.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM bots.config c WHERE c.user_id = u.id)
      ORDER BY u.id`
  );
  return { bots, unconfigured: unconfigured.rows.map((r) => r.username) };
}

export interface LogEntry {
  id: number;
  changedBy: string;
  changes: ConfigChanges;
  createdAt: Date;
}

async function logEntries(db: Db, userId: number, limit: number, offset = 0): Promise<LogEntry[]> {
  const { rows } = await db.query<{ id: number; changed_by: string; changes: ConfigChanges; created_at: Date }>(
    "SELECT id, changed_by, changes, created_at FROM bots.config_log WHERE user_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3",
    [userId, limit, offset]
  );
  return rows.map((r) => ({ id: r.id, changedBy: r.changed_by, changes: r.changes, createdAt: r.created_at }));
}

export async function getBot(ctx: BotAdminCtx, viewer: Viewer | null, name: string) {
  const bot = await findBot(ctx, viewer, name);
  const recent = config.pagination.bot_page_recent;
  const { rows: cfg } = await ctx.pool.query("SELECT * FROM bots.config WHERE user_id = $1", [bot.userId]);
  const [row, standing, runs, notes, log] = await Promise.all([
    botRow(ctx.pool, bot),
    currentStanding(ctx.pool, bot.userId),
    recentRuns(ctx.pool, bot.userId, recent),
    notesPage(ctx.pool, bot.userId, { about: "", folded: "all" }, recent, 0),
    logEntries(ctx.pool, bot.userId, recent),
  ]);
  return { row, standing, runs, notes, log, settings: settingsText(cfg[0]!) };
}

// ── Settings and controls ──────────────────────────────────────────────────

export async function updateSettings(ctx: BotAdminCtx, viewer: Viewer | null, name: string, input: SettingsInput): Promise<ConfigChanges> {
  const bot = await findBot(ctx, viewer, name);
  return settingsCall(() => applyColumns(ctx.pool, bot.userId, parseSettings(input), viewer!.username));
}

export type Control = "pause" | "resume" | "wake" | "compact" | "moderate";
export const CONTROLS: readonly Control[] = ["pause", "resume", "wake", "compact", "moderate"];

export async function controlBot(ctx: BotAdminCtx, viewer: Viewer | null, name: string, control: Control): Promise<void> {
  const bot = await findBot(ctx, viewer, name);
  if ((control === "wake" || control === "compact" || control === "moderate") && !bot.active) {
    throw invalid(`${bot.username} is paused: resume it first.`);
  }
  if (control === "moderate" && (!bot.moderates || !bot.modApiKeyRef)) {
    throw invalid(`${bot.username} doesn't moderate: turn moderation on and name its key first.`);
  }
  switch (control) {
    case "pause":
    case "resume":
      await setActive(ctx.pool, bot.userId, control === "resume", viewer!.username);
      break;
    case "wake":
      await requestWake(ctx.pool, bot.userId);
      break;
    case "compact":
      await requestCompaction(ctx.pool, bot.userId);
      break;
    case "moderate":
      await requestModeration(ctx.pool, bot.userId);
      break;
  }
}

export async function listChanges(ctx: BotAdminCtx, viewer: Viewer | null, name: string, rawPage: string | undefined) {
  const bot = await findBot(ctx, viewer, name);
  const { rows } = await ctx.pool.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM bots.config_log WHERE user_id = $1", [bot.userId]);
  const page = paginate(rawPage, rows[0]!.n, config.pagination.bot_log_per_page);
  return { bot, page, entries: await logEntries(ctx.pool, bot.userId, page.perPage, page.offset) };
}

export async function undoChange(ctx: BotAdminCtx, viewer: Viewer | null, name: string, entryId: number): Promise<void> {
  const bot = await findBot(ctx, viewer, name);
  await settingsCall(() => revertChange(ctx.pool, bot.userId, entryId, viewer!.username));
}

// ── Standing ───────────────────────────────────────────────────────────────

export interface StandingVersion {
  id: number;
  body: string;
  source: "compaction" | "admin" | "rollback";
  runId: number | null;
  createdBy: string | null;
  createdAt: Date;
}

export async function listStanding(ctx: BotAdminCtx, viewer: Viewer | null, name: string) {
  const bot = await findBot(ctx, viewer, name);
  const { rows } = await ctx.pool.query<{
    id: number;
    body: string;
    source: StandingVersion["source"];
    run_id: number | null;
    created_by: string | null;
    created_at: Date;
  }>("SELECT id, body, source, run_id, created_by, created_at FROM bots.standing_versions WHERE user_id = $1 ORDER BY id DESC", [
    bot.userId,
  ]);
  const versions: StandingVersion[] = rows.map((r) => ({
    id: r.id,
    body: r.body,
    source: r.source,
    runId: r.run_id,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }));
  return { bot, versions, current: (versions[0] ?? null) as StandingVersion | null };
}

export async function saveStanding(ctx: BotAdminCtx, viewer: Viewer | null, name: string, body: string): Promise<void> {
  const bot = await findBot(ctx, viewer, name);
  const current: Standing | null = await currentStanding(ctx.pool, bot.userId);
  if (current && current.body === body.replace(/\r\n/g, "\n").trim()) return;
  await settingsCall(() => writeStanding(ctx.pool, bot.userId, body, "admin", viewer!.username));
}

export async function restoreStanding(ctx: BotAdminCtx, viewer: Viewer | null, name: string, versionId: number): Promise<void> {
  const bot = await findBot(ctx, viewer, name);
  const { rows } = await ctx.pool.query<{ body: string }>("SELECT body FROM bots.standing_versions WHERE id = $1 AND user_id = $2", [
    versionId,
    bot.userId,
  ]);
  const old = rows[0] ?? fail404();
  await settingsCall(() => writeStanding(ctx.pool, bot.userId, old.body, "rollback", viewer!.username));
}

// ── Notes ──────────────────────────────────────────────────────────────────

export interface NoteFilter {
  about: string;
  /** "all", "current" (not yet folded) or "folded". */
  folded: "all" | "current" | "folded";
}

async function notesPage(db: Db, userId: number, f: NoteFilter, limit: number, offset: number): Promise<{ notes: Note[]; total: number }> {
  const where = ["user_id = $1"];
  const params: unknown[] = [userId];
  if (f.about) {
    params.push(f.about.replace(/^@/, "").toLowerCase());
    where.push(`LOWER(about) = $${params.length}`);
  }
  if (f.folded === "current") where.push("archived_at IS NULL");
  if (f.folded === "folded") where.push("archived_at IS NOT NULL");
  const count = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM bots.notes WHERE ${where.join(" AND ")}`, params);
  const { rows } = await db.query<{
    id: number;
    body: string;
    about: string | null;
    thread_id: number | null;
    created_at: Date;
    archived_at: Date | null;
  }>(
    `SELECT id, body, about, thread_id, created_at, archived_at FROM bots.notes WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );
  return {
    total: count.rows[0]!.n,
    notes: rows.map((r) => ({ id: r.id, body: r.body, about: r.about, threadId: r.thread_id, createdAt: r.created_at, archivedAt: r.archived_at })),
  };
}

export function noteFilter(about: string | undefined, folded: string | undefined): NoteFilter {
  return {
    about: (about ?? "").trim(),
    folded: folded === "current" || folded === "folded" ? folded : "all",
  };
}

export async function listNotes(ctx: BotAdminCtx, viewer: Viewer | null, name: string, filter: NoteFilter, rawPage: string | undefined) {
  const bot = await findBot(ctx, viewer, name);
  const perPage = config.pagination.bot_notes_per_page;
  const first = await notesPage(ctx.pool, bot.userId, filter, perPage, 0);
  const page: Page = paginate(rawPage, first.total, perPage);
  const { notes } = page.offset === 0 ? first : await notesPage(ctx.pool, bot.userId, filter, perPage, page.offset);
  return { bot, page, notes, total: first.total };
}

/** Archives a note by hand: it stops coming with every wake but stays findable with recall. */
export async function archiveNote(ctx: BotAdminCtx, viewer: Viewer | null, name: string, noteId: number): Promise<void> {
  const bot = await findBot(ctx, viewer, name);
  const { rowCount } = await ctx.pool.query(
    "UPDATE bots.notes SET archived_at = COALESCE(archived_at, NOW()) WHERE id = $1 AND user_id = $2",
    [noteId, bot.userId]
  );
  if (!rowCount) throw notFound();
}

// ── Role briefs ────────────────────────────────────────────────────────────

export interface BriefView {
  name: BriefName;
  /** The text bots get now. */
  current: string;
  /** Null while the shipped text (config/briefs/<name>.md) is in use. */
  latest: BriefVersion | null;
  versions: BriefVersion[];
  shipped: string;
}

/** The three role briefs every bot's prompt is built from, with their versions. */
export async function listBriefs(ctx: BotAdminCtx, viewer: Viewer | null): Promise<BriefView[]> {
  admin(viewer);
  const current = await currentBriefs(ctx.pool);
  const out: BriefView[] = [];
  for (const name of BRIEF_NAMES) {
    const versions = await briefVersions(ctx.pool, name, config.pagination.bot_log_per_page);
    out.push({ name, current: current[name], latest: versions[0] ?? null, versions, shipped: defaultBriefs()[name] });
  }
  return out;
}

function briefName(name: string): BriefName {
  if (!isBriefName(name)) throw notFound();
  return name;
}

/** A new version of a brief; nothing, if the text hasn't changed. */
export async function saveBrief(ctx: BotAdminCtx, viewer: Viewer | null, name: string, body: string): Promise<boolean> {
  const who = admin(viewer);
  const brief = briefName(name);
  const current = (await currentBriefs(ctx.pool))[brief];
  if (current === body.replace(/\r\n/g, "\n").trim()) return false;
  await settingsCall(() => writeBrief(ctx.pool, brief, body, who.username));
  return true;
}

/** Saves an old version, or the shipped text (versionId null), as the newest. */
export async function restoreBrief(ctx: BotAdminCtx, viewer: Viewer | null, name: string, versionId: number | null): Promise<void> {
  const who = admin(viewer);
  const brief = briefName(name);
  let body = defaultBriefs()[brief];
  if (versionId !== null) {
    const { rows } = await ctx.pool.query<{ body: string }>("SELECT body FROM bots.brief_versions WHERE id = $1 AND name = $2", [versionId, brief]);
    body = (rows[0] ?? fail404()).body;
  }
  await settingsCall(() => writeBrief(ctx.pool, brief, body, who.username));
}
