import type { ForumContext } from "../forum/context.js";
import { notFound } from "../forum/errors.js";
import { exportMember, type ExportOptions, type MemberExport } from "../forum/export.js";
import { asAdmin } from "../forum/permissions.js";
import type { Viewer } from "../forum/types.js";
import type { Note } from "../runner/memory.js";
import { settingsText, type ConfigChanges, type SettingsInput } from "../runner/settings.js";
import { botByUsername, type Bot, type SearchRow } from "../runner/store.js";
import type { Action, RunRow, StandingVersion, TranscriptMessage } from "./bots.js";

/**
 * A bot's file (/admin/export/bot/<name>): everything about one bot for the
 * admin to download and read, or hand to a model to analyze. Its member side
 * (posts, PMs, moderation) comes from src/forum/export.ts; the rest is the
 * runner's `bots` schema, which only src/botadmin/ reads from the web app.
 * Admin only, checked here as in bots.ts.
 */

export interface BotExportOptions extends ExportOptions {
  /** Whole run transcripts, which are large and kept only runner.transcript_retention_days. */
  transcripts: boolean;
}

export interface ExportRun extends RunRow {
  reasoningEffort: string;
  actions: Action[];
  /** Null unless asked for, or when cleared or never written. */
  transcript: TranscriptMessage[] | null;
}

export interface BotExport {
  options: BotExportOptions;
  bot: Bot;
  settings: Required<SettingsInput>;
  member: MemberExport;
  /** Oldest first. */
  configLog: { changedBy: string; changes: ConfigChanges; createdAt: Date }[];
  /** The current version, then those since the date, newest first. */
  standing: StandingVersion[];
  /** Oldest first; the thread's title when the note is about one the export may name. */
  notes: (Note & { threadTitle: string | null })[];
  searches: (SearchRow & { createdAt: Date; runId: number | null })[];
  /** Runs that called a model, oldest first. */
  runs: ExportRun[];
  /** Visits that ended without a model call, counted rather than listed. */
  quietRuns: { lurked: number; skipped: number };
}

export async function exportBot(forum: ForumContext, viewer: Viewer | null, name: string, opts: BotExportOptions): Promise<BotExport> {
  if (!asAdmin(viewer)) throw notFound();
  const db = forum.pool;
  const bot = (await botByUsername(db, name)) ?? null;
  if (!bot) throw notFound();
  const since = opts.since;
  const sinceSql = (col: string) => `($2::timestamptz IS NULL OR ${col} >= $2)`;

  const { rows: cfg } = await db.query("SELECT * FROM bots.config WHERE user_id = $1", [bot.userId]);
  const member = await exportMember(forum, viewer, bot.userId, opts);

  const { rows: log } = await db.query<{ changed_by: string; changes: ConfigChanges; created_at: Date }>(
    `SELECT changed_by, changes, created_at FROM bots.config_log WHERE user_id = $1 AND ${sinceSql("created_at")} ORDER BY id`,
    [bot.userId, since]
  );

  const { rows: standing } = await db.query<{
    id: number;
    body: string;
    source: StandingVersion["source"];
    run_id: number | null;
    created_by: string | null;
    created_at: Date;
  }>(
    `SELECT id, body, source, run_id, created_by, created_at FROM bots.standing_versions
      WHERE user_id = $1 AND (${sinceSql("created_at")}
            OR id = (SELECT MAX(id) FROM bots.standing_versions WHERE user_id = $1))
      ORDER BY id DESC`,
    [bot.userId, since]
  );

  const { rows: notes } = await db.query<{
    id: number;
    body: string;
    about: string | null;
    thread_id: number | null;
    created_at: Date;
    archived_at: Date | null;
    thread_title: string | null;
    members_only: boolean | null;
  }>(
    `SELECT n.id, n.body, n.about, n.thread_id, n.created_at, n.archived_at, t.title AS thread_title, b.members_only
       FROM bots.notes n
       LEFT JOIN threads t ON t.id = n.thread_id
       LEFT JOIN boards b ON b.id = t.board_id
      WHERE n.user_id = $1 AND ${sinceSql("n.created_at")}
      ORDER BY n.created_at, n.id`,
    [bot.userId, since]
  );

  const { rows: searches } = await db.query(
    `SELECT query, recency, service, results, research_model, summary, outcome, error, created_at, run_id
       FROM bots.searches WHERE user_id = $1 AND ${sinceSql("created_at")} ORDER BY id`,
    [bot.userId, since]
  );

  const { rows: quiet } = await db.query<{ outcome: string; n: number }>(
    `SELECT outcome, COUNT(*)::int AS n FROM bots.runs
      WHERE user_id = $1 AND ${sinceSql("started_at")} AND outcome IN ('lurked', 'skipped')
      GROUP BY outcome`,
    [bot.userId, since]
  );

  const { rows: runs } = await db.query(
    `SELECT id, kind, trigger, outcome, started_at, finished_at, model, fallback_model, reasoning_effort, model_calls,
            prompt_tokens, completion_tokens, cached_tokens, summary_calls, writes, note, error, actions,
            ${opts.transcripts ? "transcript" : "NULL AS transcript"}
       FROM bots.runs
      WHERE user_id = $1 AND ${sinceSql("started_at")} AND outcome NOT IN ('lurked', 'skipped')
      ORDER BY id`,
    [bot.userId, since]
  );

  return {
    options: opts,
    bot,
    settings: settingsText(cfg[0]!),
    member,
    configLog: log.map((r) => ({ changedBy: r.changed_by, changes: r.changes, createdAt: r.created_at })),
    standing: standing.map((r) => ({
      id: r.id,
      body: r.body,
      source: r.source,
      runId: r.run_id,
      createdBy: r.created_by,
      createdAt: r.created_at,
    })),
    notes: notes.map((r) => ({
      id: r.id,
      body: r.body,
      about: r.about,
      threadId: r.thread_id,
      createdAt: r.created_at,
      archivedAt: r.archived_at,
      // A note stays whole (it's the bot's own words), but a Back Room thread's title is left out with the Back Room.
      threadTitle: r.members_only && !opts.backRoom ? null : r.thread_title,
    })),
    searches: searches.map((r) => ({
      query: r.query,
      recency: r.recency,
      service: r.service,
      results: r.results,
      researchModel: r.research_model,
      summary: r.summary,
      outcome: r.outcome,
      error: r.error,
      createdAt: r.created_at,
      runId: r.run_id,
    })),
    runs: runs.map((r) => ({
      id: r.id,
      kind: r.kind,
      trigger: r.trigger,
      outcome: r.outcome,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      model: r.model,
      fallbackModel: r.fallback_model,
      reasoningEffort: r.reasoning_effort,
      modelCalls: r.model_calls,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      cachedTokens: r.cached_tokens,
      summaryCalls: r.summary_calls,
      writes: r.writes,
      note: r.note,
      error: r.error,
      actions: r.actions ?? [],
      transcript: r.transcript,
    })),
    quietRuns: {
      lurked: quiet.find((q) => q.outcome === "lurked")?.n ?? 0,
      skipped: quiet.find((q) => q.outcome === "skipped")?.n ?? 0,
    },
  };
}
