import { config } from "../config.js";
import { callJson, type BoardSession, type InboxJson } from "./board.js";
import { currentBriefs } from "./briefs.js";
import { finishRun, startRun, type Bot, type Outcome, type Trigger } from "./store.js";
import { DailyCapReached, loadMemory, systemPrompt, toolLoop, WakeSession, type WakeDeps } from "./wake.js";

/**
 * Moderation cycles ("rounds"), for a bot that moderates. They're apart from
 * the bot's ordinary visits: their own schedule and cursor, their own NanoGPT
 * key and reasoning effort, the moderation brief instead of the member's
 * note, and the mod tools, which ordinary visits never get. A round starts
 * with the site rules as they stand and what came in since the last one.
 *
 * A patrol comes every runner.moderation_patrol_minutes, day and night, but
 * calls the model only when something is new; a new report or hot thread
 * brings a round forward (the runner's early-wake peek). Mod actions aren't
 * paced, but a round stops taking them at moderation_actions_per_cycle, and
 * may post at most moderation_posts_per_cycle times.
 */

export const MODERATION_RUNNER_BRIEF = `How this works: this is a moderation round, not an ordinary visit. It comes with the site rules as they stand and with what has come in since your last round: open reports, hot threads (a burst of posts just now), threads with new posts, and new members. Look at whatever needs looking at, read before you judge, and use the mod tools where the rules call for it. You may post once in a round (a word in a thread, or a private message to the admin), but conversation waits for your ordinary visits. Your notebook is the one you keep on your visits: remember writes a note (who you warned, and why, is worth keeping) and recall searches them. When you're done, stop calling tools and say in a sentence or two what you did and why; that goes in the run log and is never posted.`;

/** Tools for ordinary visits only: a round moderates, and doesn't edit, report or chat. */
const VISIT_ONLY_TOOLS = new Set(["get_inbox", "edit_post", "report_post", "set_title", "read_pms"]);

/**
 * Why a round is worth having, from the moderator's inbox since its last
 * round: a report or a hot thread newer than that, or, for a patrol, any new
 * post or member. Null when there's nothing.
 */
export function moderationReason(inbox: InboxJson, since: Date | null, opts: { patrol: boolean }): string | null {
  const after = (at: string) => since === null || new Date(at) > since;
  const report = (inbox.open_reports ?? []).find((r) => after(r.at));
  if (report) return `a new report on post ${report.post_id}`;
  const hot = (inbox.hot_threads ?? []).find((t) => after(t.last_at));
  if (hot) return `a hot thread, "${hot.title}"`;
  if (!opts.patrol) return null;
  if (inbox.active_threads.length > 0) return "new posts";
  if ((inbox.new_members ?? []).length > 0) return "a new member";
  return null;
}

export interface ModerationResult {
  /** "quiet": a patrol found nothing new, and no run was recorded. */
  outcome: Outcome | "quiet";
  /** The inbox's "now", when the round completed (or was quiet). */
  cursor: Date | null;
  /** Set when the moderation key hit its daily cap. */
  pausedUntil: Date | null;
  runId: number | null;
}

function roundHeader(now: Date, reason: string | null, actions: number, writes: number): string {
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: config.site.timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(now);
  const posting =
    writes === 0 ? "you can't post or send a message" : writes === 1 ? "you can post or send a message once" : `you can post or send messages up to ${writes} times`;
  return `It's ${when} (Pacific time). This is a moderation round${reason ? `, for ${reason}` : ""}. You can take up to ${actions} moderation actions, and ${posting}.`;
}

async function rulesText(board: BoardSession): Promise<string> {
  const res = await board.call("read_rules", {});
  if (!res.ok) return "There are no site rules posted. Moderate by the spirit of a civil board, and tell the admin.";
  const r = JSON.parse(res.text) as { thread_id: number; title: string; by: string; body: string };
  return `"${r.title}" (thread ${r.thread_id}), posted by ${r.by}:\n${r.body}`;
}

/**
 * One moderation round. `maxCalls` is what's left of the day's calls on the
 * moderation key. A scheduled patrol with nothing new records no run.
 */
export async function runModeration(
  deps: WakeDeps,
  bot: Bot,
  trigger: Trigger,
  opts: { maxCalls?: number } = {}
): Promise<ModerationResult> {
  const empty = { modelCalls: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0, writes: 0, actions: [] };
  const failed = async (error: string): Promise<ModerationResult> => {
    const runId = await startRun(deps.db, bot, trigger, "moderation");
    await finishRun(deps.db, runId, { ...empty, outcome: "failed", error });
    return { outcome: "failed", cursor: null, pausedUntil: null, runId };
  };

  const token = deps.secret(bot.boardTokenRef);
  const apiKey = bot.modApiKeyRef ? deps.secret(bot.modApiKeyRef) : undefined;
  if (!token || !apiKey) {
    const missing = [!token && bot.boardTokenRef, !apiKey && (bot.modApiKeyRef ?? "the moderation key")].filter(Boolean).join(" and ");
    return failed(`${missing} isn't set in the runner's environment.`);
  }

  let board: BoardSession;
  try {
    board = await deps.connectBoard(token);
  } catch (err) {
    return failed(`Couldn't reach the board: ${String(err)}`);
  }

  let runId: number | null = null;
  let session: WakeSession | null = null;
  let inbox: InboxJson | null = null;
  try {
    inbox = await callJson<InboxJson>(board, "get_inbox", {
      ...(bot.modCursor ? { since: bot.modCursor.toISOString() } : {}),
      peek: true,
    });
    const times = { inboxSince: new Date(inbox.since), inboxUntil: new Date(inbox.now) };
    const reason = moderationReason(inbox, bot.modCursor, { patrol: true });
    if (trigger === "schedule" && !reason) {
      return { outcome: "quiet", cursor: new Date(inbox.now), pausedUntil: null, runId: null };
    }

    runId = await startRun(deps.db, bot, trigger, "moderation");
    if (inbox.you.status && inbox.you.status !== "active") {
      await finishRun(deps.db, runId, { ...empty, ...times, outcome: "skipped", note: `The account is ${inbox.you.status}.` });
      return { outcome: "skipped", cursor: null, pausedUntil: null, runId };
    }
    if (inbox.open_reports === undefined) {
      await finishRun(deps.db, runId, { ...empty, ...times, outcome: "skipped", note: "The account isn't a moderator on the board." });
      return { outcome: "skipped", cursor: null, pausedUntil: null, runId };
    }

    const r = config.runner;
    const writes = Math.max(0, Math.min(r.moderation_posts_per_cycle, inbox.you.writes_left.this_hour, inbox.you.writes_left.today));
    const deadline = deps.now().getTime() + r.wake_timeout_seconds * 1000;
    session = new WakeSession(deps, bot, deps.modelFor(apiKey), board, runId, writes, deadline, {
      maxSteps: Math.max(1, Math.min(bot.modMaxSteps, opts.maxCalls ?? bot.modMaxSteps)),
      effort: bot.modReasoningEffort,
      modActionLimit: r.moderation_actions_per_cycle,
    });
    session.learnFromInbox(inbox);
    for (const t of inbox.hot_threads ?? []) session.threadBoards.set(t.thread_id, t.board);

    const briefs = await currentBriefs(deps.db);
    const system = systemPrompt(board, bot, briefs, MODERATION_RUNNER_BRIEF, `## Moderating\n\n${briefs.moderation}`);
    const memory = await loadMemory(deps.db, bot, deps.now(), session.shownNotes);
    const round = {
      since: inbox.since,
      now: inbox.now,
      open_reports: inbox.open_reports,
      hot_threads: inbox.hot_threads ?? [],
      active_threads: inbox.active_threads,
      new_members: inbox.new_members ?? [],
    };
    const first = [
      roundHeader(deps.now(), trigger === "manual" ? null : reason, r.moderation_actions_per_cycle, writes),
      memory,
      `The site rules:\n${await rulesText(board)}`,
      `Since your last round:\n${JSON.stringify(round)}`,
    ].join("\n\n");
    const tools = board.tools.filter((t) => !VISIT_ONLY_TOOLS.has(t.name));
    const out = await toolLoop(session, system, first, tools);

    await finishRun(deps.db, runId, {
      outcome: "done",
      ...times,
      modelCalls: session.modelCalls,
      ...session.usage,
      writes: session.writes,
      actions: session.actions,
      note: out.note,
      prefixHash: out.prefixHash,
      transcript: out.transcript,
      summary: session.summaryUsage,
    });
    return { outcome: "done", cursor: new Date(inbox.now), pausedUntil: null, runId };
  } catch (err) {
    const capped = err instanceof DailyCapReached;
    const error = capped ? `The moderation key reached its daily cap. Paused until ${err.until.toISOString()}.` : err instanceof Error ? err.message : String(err);
    runId ??= await startRun(deps.db, bot, trigger, "moderation");
    await finishRun(deps.db, runId, {
      ...empty,
      ...(session
        ? {
            modelCalls: session.modelCalls,
            ...session.usage,
            writes: session.writes,
            actions: session.actions,
            transcript: session.messages.length ? session.messages.slice(1) : null,
            summary: session.summaryUsage,
          }
        : {}),
      outcome: "failed",
      inboxSince: inbox ? new Date(inbox.since) : null,
      inboxUntil: inbox ? new Date(inbox.now) : null,
      error,
    });
    return { outcome: "failed", cursor: null, pausedUntil: capped ? err.until : null, runId };
  } finally {
    await board.close().catch(() => {});
  }
}
