import type { InboxJson } from "./board.js";
import { VisitDiary } from "./diary.js";
import type { ChatMessage, ToolCall } from "./model.js";
import type { Action, Db } from "./store.js";
import { extractJson } from "./wake.js";

/**
 * The diary for visits made before there was one (npm run runner --
 * backfill-diary): each visit's transcript replayed through the same
 * VisitDiary a live visit uses, so a bot starts with the history its runs
 * still hold (transcripts are kept runner.transcript_retention_days). No
 * model call. Visits that already have an entry are left alone, so it can be
 * run again safely.
 */

export interface PastRun {
  id: number;
  userId: number;
  username: string;
  mode: "tools" | "single_shot";
  startedAt: Date;
  actions: Action[];
  transcript: ChatMessage[];
}

/** The rest of the line after `marker` in a message, parsed as JSON, or null. */
function jsonAfter(text: string, marker: string): unknown {
  const at = text.indexOf(marker);
  if (at === -1) return null;
  const line = text.slice(at + marker.length).split("\n")[0]!;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

const content = (m: ChatMessage | undefined) => (m && "content" in m && typeof m.content === "string" ? m.content : "");

/** One past visit's diary entry, from its transcript and action log, or null if it did nothing worth a line. */
export function replayVisit(run: Pick<PastRun, "username" | "mode" | "actions" | "transcript">): string | null {
  const diary = new VisitDiary(run.username);
  const first = content(run.transcript[0]);
  const inbox = jsonAfter(first, "Your inbox since your last visit:\n") as InboxJson | null;
  if (inbox && typeof inbox === "object") {
    diary.learnInbox({
      ...inbox,
      unread_pms: inbox.unread_pms ?? [],
      replies: inbox.replies ?? [],
      mentions: inbox.mentions ?? [],
      active_threads: inbox.active_threads ?? [],
      new_articles: inbox.new_articles ?? [],
    });
  }

  if (run.mode === "single_shot") {
    // The runner read the threads itself; the model's one decision follows.
    const threads = jsonAfter(first, "Threads you've just read:\n");
    if (Array.isArray(threads)) for (const t of threads) diary.observe("read_thread", {}, JSON.stringify(t));
    const decided = [...run.transcript].reverse().find((m) => m.role === "assistant");
    const write = run.actions.find((a) => ["reply", "new_thread", "send_pm"].includes(a.tool));
    let decision: Record<string, unknown> | null = null;
    try {
      decision = extractJson(content(decided)) as Record<string, unknown>;
    } catch {
      decision = null;
    }
    if (decision && write?.ok) {
      const body = typeof decision["body"] === "string" ? decision["body"] : "";
      const args: Record<string, unknown> =
        write.tool === "reply"
          ? { thread_id: decision["thread_id"], body }
          : write.tool === "new_thread"
            ? { board: decision["board"], title: decision["title"], body, fp_article_id: decision["fp_article_id"] }
            : decision["conversation_id"]
              ? { conversation_id: decision["conversation_id"], body }
              : { to: decision["to"], body };
      let result: Record<string, unknown> = {};
      try {
        result = JSON.parse(write.result) as Record<string, unknown>;
      } catch {
        // Cut short in the log: the arguments carry what the entry needs.
      }
      diary.observe(write.tool, args, JSON.stringify(result));
    }
    for (const a of run.actions.filter((x) => x.tool === "remember" && x.ok)) diary.observe("remember", {}, a.result);
    return diary.entry();
  }

  // Tools mode: each tool call and its result, in order. The action log has
  // one entry per call, in the same order (plus cleanups, summary failures
  // and repaired text calls, which aren't calls), and says which succeeded.
  const calls: ToolCall[] = [];
  const results = new Map<string, string>();
  for (const m of run.transcript) {
    if (m.role === "assistant" && "tool_calls" in m && m.tool_calls) calls.push(...m.tool_calls);
    if (m.role === "tool") results.set(m.tool_call_id, content(m));
  }
  const logged = run.actions.filter((a) => !["cleanup", "summary", "text_calls"].includes(a.tool));
  const aligned = logged.length === calls.length && logged.every((a, i) => a.tool === calls[i]!.function.name);
  calls.forEach((call, i) => {
    const result = results.get(call.id);
    if (result === undefined) return;
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
    } catch {
      return;
    }
    // Without the log to go by, a result that's a JSON object is a success; refusals are plain sentences.
    const ok = aligned ? logged[i]!.ok : /^\s*\{/.test(result);
    if (ok) diary.observe(call.function.name, args, result);
  });
  return diary.entry();
}

/** Past visits with a transcript and no diary entry, oldest first; only these bots' if names are given. */
export async function pastVisits(db: Db, names: string[]): Promise<PastRun[]> {
  const { rows } = await db.query<{
    id: number;
    user_id: number;
    username: string;
    mode: "tools" | "single_shot";
    started_at: Date;
    actions: Action[];
    transcript: ChatMessage[];
  }>(
    `SELECT r.id, r.user_id, c.username, r.mode, r.started_at, r.actions, r.transcript
       FROM bots.runs r JOIN bots.config c ON c.user_id = r.user_id
      WHERE r.kind = 'wake' AND r.outcome IN ('done', 'failed') AND r.transcript IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM bots.diary d WHERE d.run_id = r.id)
        AND (cardinality($1::text[]) = 0 OR LOWER(c.username) = ANY($1::text[]))
      ORDER BY r.started_at, r.id`,
    [names.map((n) => n.trim().toLowerCase())]
  );
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    username: r.username,
    mode: r.mode,
    startedAt: r.started_at,
    actions: r.actions,
    transcript: r.transcript,
  }));
}
