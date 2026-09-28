import { config } from "../config.js";
import type { Db } from "./store.js";

/**
 * A bot's memory, in the `bots` schema: the notes it writes itself, its
 * standing document, and the thread summaries all bots share. The runner
 * reads and writes these as the bot's own tools (`remember`, `recall`) and
 * around them (what a wake starts with, notes that come with a thread,
 * compaction); the admin pages edit them too (src/botadmin/).
 */

export interface Note {
  id: number;
  body: string;
  about: string | null;
  threadId: number | null;
  createdAt: Date;
  archivedAt: Date | null;
}

interface NoteRow {
  id: number;
  body: string;
  about: string | null;
  thread_id: number | null;
  created_at: Date;
  archived_at: Date | null;
}

const NOTE_COLUMNS = "id, body, about, thread_id, created_at, archived_at";

const toNote = (r: NoteRow): Note => ({
  id: r.id,
  body: r.body,
  about: r.about,
  threadId: r.thread_id,
  createdAt: r.created_at,
  archivedAt: r.archived_at,
});

const DAY = 24 * 60 * 60_000;

/** The start of the recent-notes window. */
export function recentSince(now: Date): Date {
  return new Date(now.getTime() - config.runner.recent_notes_days * DAY);
}

export async function insertNote(
  db: Db,
  userId: number,
  n: { body: string; about: string | null; threadId: number | null; runId: number | null }
): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    "INSERT INTO bots.notes (user_id, body, about, thread_id, run_id) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [userId, n.body, n.about, n.threadId, n.runId]
  );
  return rows[0]!.id;
}

/** Unarchived notes since the start of the recent window, the newest `recent_notes_max`, oldest first. */
export async function recentNotes(db: Db, userId: number, now: Date): Promise<Note[]> {
  const { rows } = await db.query<NoteRow>(
    `SELECT * FROM (
       SELECT ${NOTE_COLUMNS} FROM bots.notes
        WHERE user_id = $1 AND archived_at IS NULL AND created_at >= $2
        ORDER BY created_at DESC, id DESC LIMIT $3
     ) n ORDER BY created_at, id`,
    [userId, recentSince(now), config.runner.recent_notes_max]
  );
  return rows.map(toNote);
}

/**
 * The bot's newest notes about each of these members, archived ones
 * included, leaving out notes it has already been shown this wake.
 */
export async function notesAbout(db: Db, userId: number, names: string[], exclude: number[]): Promise<Map<string, Note[]>> {
  const out = new Map<string, Note[]>();
  if (names.length === 0 || config.runner.notes_per_person === 0) return out;
  const { rows } = await db.query<NoteRow & { who: string }>(
    `SELECT * FROM (
       SELECT ${NOTE_COLUMNS}, LOWER(about) AS who,
              ROW_NUMBER() OVER (PARTITION BY LOWER(about) ORDER BY created_at DESC, id DESC) AS n
         FROM bots.notes
        WHERE user_id = $1 AND LOWER(about) = ANY($2::text[]) AND NOT (id = ANY($3::bigint[]))
     ) x WHERE n <= $4 ORDER BY created_at DESC, id DESC`,
    [userId, names.map((n) => n.toLowerCase()), exclude, config.runner.notes_per_person]
  );
  for (const name of names) {
    const mine = rows.filter((r) => r.who === name.toLowerCase()).map(toNote);
    if (mine.length) out.set(name, mine);
  }
  return out;
}

/**
 * `recall`: the bot's notes, archived ones included, newest first, matching
 * words (Postgres full text), a member, both, or neither (the latest).
 */
export async function recallNotes(
  db: Db,
  userId: number,
  query: string,
  about: string,
  limit: number = config.runner.recall_results
): Promise<Note[]> {
  const where = ["user_id = $1"];
  const params: unknown[] = [userId];
  if (query) {
    params.push(query);
    where.push(`search_vector @@ websearch_to_tsquery('english', $${params.length})`);
  }
  if (about) {
    params.push(about.toLowerCase());
    where.push(`LOWER(about) = $${params.length}`);
  }
  params.push(limit);
  const { rows } = await db.query<NoteRow>(
    `SELECT ${NOTE_COLUMNS} FROM bots.notes WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params
  );
  return rows.map(toNote);
}

export interface Standing {
  id: number;
  body: string;
  createdAt: Date;
}

/** The current standing document: the newest version, or null before the first. */
export async function currentStanding(db: Db, userId: number): Promise<Standing | null> {
  const { rows } = await db.query<{ id: number; body: string; created_at: Date }>(
    "SELECT id, body, created_at FROM bots.standing_versions WHERE user_id = $1 ORDER BY id DESC LIMIT 1",
    [userId]
  );
  const r = rows[0];
  return r ? { id: r.id, body: r.body, createdAt: r.created_at } : null;
}

// ── Compaction's bookkeeping ───────────────────────────────────────────────

export interface NoteStats {
  /** Unarchived notes, and their total length. */
  count: number;
  chars: number;
  /** Unarchived notes older than the recent window. */
  old: number;
}

export async function noteStats(db: Db, userId: number, now: Date): Promise<NoteStats> {
  const { rows } = await db.query<NoteStats>(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(LENGTH(body)), 0)::int AS chars,
            (COUNT(*) FILTER (WHERE created_at < $2))::int AS old
       FROM bots.notes WHERE user_id = $1 AND archived_at IS NULL`,
    [userId, recentSince(now)]
  );
  return rows[0]!;
}

/** When the bot's last compaction succeeded, and when one was last tried. */
export async function lastCompaction(db: Db, userId: number): Promise<{ done: Date | null; tried: Date | null }> {
  const { rows } = await db.query<{ done: Date | null; tried: Date | null }>(
    `SELECT MAX(started_at) FILTER (WHERE outcome = 'done') AS done, MAX(started_at) AS tried
       FROM bots.runs WHERE user_id = $1 AND kind = 'compaction'`,
    [userId]
  );
  return rows[0] ?? { done: null, tried: null };
}

/**
 * The unarchived notes a compaction folds, oldest first: those older than
 * the recent window; every one (`all`, the admin's "compact now"); or, when
 * the notes are over the size limits but all recent, the older half.
 */
export async function notesToFold(db: Db, userId: number, now: Date, all: boolean): Promise<Note[]> {
  const { rows } = await db.query<NoteRow>(
    `SELECT ${NOTE_COLUMNS} FROM bots.notes WHERE user_id = $1 AND archived_at IS NULL ORDER BY created_at, id`,
    [userId]
  );
  const notes = rows.map(toNote);
  if (all) return notes;
  const since = recentSince(now);
  const old = notes.filter((n) => n.createdAt < since);
  return old.length > 0 ? old : notes.slice(0, Math.floor(notes.length / 2));
}

/**
 * Saves a compaction: a new standing version and the folded notes archived,
 * in one statement. Nothing is saved if the standing document changed since
 * the compaction read it (the admin edited it meanwhile); returns the new
 * version's id, or null then.
 */
export async function saveCompaction(
  db: Db,
  userId: number,
  body: string,
  runId: number,
  basedOn: number | null,
  noteIds: number[]
): Promise<number | null> {
  const { rows } = await db.query<{ version_id: number | null }>(
    `WITH ins AS (
       INSERT INTO bots.standing_versions (user_id, body, source, run_id)
       SELECT $1, $2, 'compaction', $3
        WHERE (SELECT MAX(id) FROM bots.standing_versions WHERE user_id = $1) IS NOT DISTINCT FROM $4::bigint
       RETURNING id
     ), archived AS (
       UPDATE bots.notes SET archived_at = NOW()
        WHERE user_id = $1 AND id = ANY($5::bigint[]) AND archived_at IS NULL AND EXISTS (SELECT 1 FROM ins)
       RETURNING id
     )
     SELECT (SELECT id FROM ins) AS version_id, (SELECT COUNT(*) FROM archived) AS archived`,
    [userId, body, runId, basedOn, noteIds]
  );
  return rows[0]?.version_id ?? null;
}

// ── Thread summaries ───────────────────────────────────────────────────────

export interface ThreadSummary {
  threadId: number;
  throughPost: number;
  body: string;
  builtAt: Date;
}

export async function getSummary(db: Db, threadId: number): Promise<ThreadSummary | null> {
  const { rows } = await db.query<{ thread_id: number; through_post: number; body: string; built_at: Date }>(
    "SELECT thread_id, through_post, body, built_at FROM bots.thread_summaries WHERE thread_id = $1",
    [threadId]
  );
  const r = rows[0];
  return r ? { threadId: r.thread_id, throughPost: r.through_post, body: r.body, builtAt: r.built_at } : null;
}

/** Stores a summary. `rebuilt` means it was written from the first post, which restarts its age. */
export async function saveSummary(
  db: Db,
  s: { threadId: number; throughPost: number; body: string; model: string; rebuilt: boolean }
): Promise<void> {
  await db.query(
    `INSERT INTO bots.thread_summaries (thread_id, through_post, body, model)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (thread_id) DO UPDATE
       SET through_post = EXCLUDED.through_post, body = EXCLUDED.body, model = EXCLUDED.model,
           built_at = CASE WHEN $5 THEN NOW() ELSE bots.thread_summaries.built_at END,
           updated_at = NOW()`,
    [s.threadId, s.throughPost, s.body, s.model, s.rebuilt]
  );
}

// ── How memory reads to the bot ────────────────────────────────────────────

const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: config.site.timezone, year: "numeric", month: "2-digit", day: "2-digit" });

/** A note as one line: "2026-09-20 · about Dan · thread 41: …". */
export function noteLine(n: Note, opts: { about?: boolean } = {}): string {
  const parts = [dayFormat.format(n.createdAt)];
  if (n.about && opts.about !== false) parts.push(`about ${n.about}`);
  if (n.threadId) parts.push(`thread ${n.threadId}`);
  return `${parts.join(" · ")}: ${n.body}`;
}

/** The part of a wake's first message that carries the bot's memory. */
export function memoryText(standing: string | null, recent: Note[]): string {
  const lines = ["Your notebook (private: only you ever see it)."];
  lines.push(
    standing?.trim()
      ? `\nYour standing notes, what you've come to think so far:\n${standing.trim()}`
      : "\nYou have no standing notes yet; they grow out of your notes over time."
  );
  lines.push(
    recent.length
      ? `\nYour notes from the last ${config.runner.recent_notes_days} days:\n${recent.map((n) => `- ${noteLine(n)}`).join("\n")}`
      : `\nNo notes from the last ${config.runner.recent_notes_days} days.`
  );
  return lines.join("\n");
}
