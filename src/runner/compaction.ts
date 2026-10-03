import { createHash } from "node:crypto";
import { config } from "../config.js";
import { currentStanding, lastCompaction, noteLine, notesToFold, noteStats, saveCompaction } from "./memory.js";
import type { ChatMessage } from "./model.js";
import { isAwake } from "./schedule.js";
import { finishRun, startRun, type Bot, type Outcome, type Trigger } from "./store.js";
import { DailyCapReached, MeteredModel, type WakeDeps } from "./wake.js";

/**
 * Compaction: the bot's own model rewrites its standing document from the
 * old one plus its older notes, which are then archived (never deleted).
 * Every version of the document is kept, so a bad rewrite can be rolled
 * back from the admin pages. It runs outside wakes, while the bot is asleep,
 * and is logged as a run of its own.
 */

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/**
 * Whether the bot is due a compaction: "manual" when the admin asked for
 * one, "schedule" when it's asleep and either a week has passed with old
 * notes waiting or its notes have outgrown the limits.
 */
export async function compactionDue(deps: Pick<WakeDeps, "db">, bot: Bot, now: Date): Promise<Trigger | null> {
  if (bot.compactRequestedAt) return "manual";
  const r = config.runner;
  // A bot awake all day compacts whenever it's due; the rest wait for the night.
  const sleeps = bot.schedule.start !== bot.schedule.end;
  if (sleeps && isAwake(now, bot.schedule)) return null;
  const last = await lastCompaction(deps.db, bot.userId);
  if (last.tried && now.getTime() - last.tried.getTime() < r.compaction_retry_hours * HOUR) return null;
  const stats = await noteStats(deps.db, bot.userId, now);
  if (stats.count === 0) return null;
  const oversize = stats.count > r.compaction_max_notes || stats.chars > r.compaction_max_chars;
  const weekly = stats.old > 0 && (!last.done || now.getTime() - last.done.getTime() >= r.compaction_every_days * DAY);
  return oversize || weekly ? "schedule" : null;
}

const COMPACTION_BRIEF = `You keep a private notebook for your visits to the board. Your standing notes are the part you carry into every visit: what you've come to think about the regulars, running jokes, friendships and grudges, positions you've taken on recurring topics, and anything you've promised or been asked. Now fold the notes below into your standing notes. Rewrite the whole document, in your own voice, keeping what still matters and letting go of what doesn't. Keep usernames exactly as written. Answer with only the new standing notes: no preface, no sign-off.`;

export interface CompactionResult {
  outcome: Outcome;
  runId: number;
  pausedUntil: Date | null;
}

/** Strips a code fence a model may wrap the document in. */
function unfence(text: string): string {
  const m = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(text.trim());
  return (m ? m[1]! : text).trim();
}

export async function runCompaction(deps: WakeDeps, bot: Bot, trigger: Trigger): Promise<CompactionResult> {
  const runId = await startRun(deps.db, bot, trigger, "compaction");
  const base = { writes: 0, actions: [] };
  const apiKey = deps.secret(bot.apiKeyRef);
  if (!apiKey) {
    await finishRun(deps.db, runId, {
      ...base,
      modelCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
      cachedTokens: 0,
      outcome: "failed",
      error: `${bot.apiKeyRef} isn't set in the runner's environment.`,
    });
    return { outcome: "failed", runId, pausedUntil: null };
  }

  const now = deps.now();
  const max = config.runner.standing_max_chars;
  const m = new MeteredModel(deps, bot, deps.modelFor(apiKey));
  const messages: ChatMessage[] = [];
  const record = (outcome: Outcome, extra: { note?: string; error?: string }) =>
    finishRun(deps.db, runId, {
      ...base,
      outcome,
      modelCalls: m.modelCalls,
      ...m.usage,
      fallbackModel: m.fallbackModel,
      prefixHash: messages[0] ? createHash("sha256").update(String(messages[0].content)).digest("hex").slice(0, 16) : null,
      transcript: messages.length > 1 ? messages.slice(1) : null,
      ...extra,
    });

  try {
    const standing = await currentStanding(deps.db, bot.userId);
    const notes = await notesToFold(deps.db, bot.userId, now, trigger === "manual");
    if (notes.length === 0) {
      await record("skipped", { note: "No notes to fold." });
      return { outcome: "skipped", runId, pausedUntil: null };
    }
    messages.push(
      {
        role: "system",
        content: `${bot.personaPrompt.trim() || `You are ${bot.username}.`}\n\n## Your notebook\n\n${COMPACTION_BRIEF}`,
      },
      {
        role: "user",
        content: [
          standing?.body.trim() ? `Your standing notes now:\n${standing.body.trim()}` : "You have no standing notes yet.",
          `Notes to fold in, oldest first:\n${notes.map((n) => `- ${noteLine(n)}`).join("\n")}`,
          `Write your new standing notes, in at most ${max} characters.`,
        ].join("\n\n"),
      }
    );
    let body = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await m.complete({ messages });
      messages.push({ role: "assistant", content: res.content });
      body = unfence(res.content ?? "");
      if (body && body.length <= max) break;
      if (attempt === 2) break;
      messages.push({
        role: "user",
        content: body
          ? `That's ${body.length} characters; the limit is ${max}. Shorten it, and answer with only the notes.`
          : "That was empty. Answer with only your new standing notes.",
      });
    }
    if (!body || body.length > max) {
      const error = body ? `The new standing notes were ${body.length} characters, over the ${max} limit.` : "The model wrote no standing notes.";
      await record("failed", { error });
      return { outcome: "failed", runId, pausedUntil: null };
    }
    const versionId = await saveCompaction(deps.db, bot.userId, body, runId, standing?.id ?? null, notes.map((n) => n.id));
    if (versionId === null) {
      await record("failed", { error: "The standing notes were edited while this ran; nothing was saved." });
      return { outcome: "failed", runId, pausedUntil: null };
    }
    await record("done", { note: `Folded ${notes.length} note(s) into the standing notes (${body.length} characters).` });
    return { outcome: "done", runId, pausedUntil: null };
  } catch (err) {
    const capped = err instanceof DailyCapReached;
    await record("failed", {
      error: capped ? `${err.message} Paused until ${err.until.toISOString()}.` : err instanceof Error ? err.message : String(err),
    });
    return { outcome: "failed", runId, pausedUntil: capped ? err.until : null };
  }
}
