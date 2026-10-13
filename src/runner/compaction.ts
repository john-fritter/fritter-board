import { createHash } from "node:crypto";
import { config } from "../config.js";
import { diaryLine, diaryOldest, diarySince } from "./diary.js";
import { currentStanding, lastCompaction, noteLine, notesToFold, noteStats, saveCompaction } from "./memory.js";
import type { ChatMessage } from "./model.js";
import { personaPrompt } from "./persona.js";
import { isAwake } from "./schedule.js";
import { finishRun, startRun, type Bot, type Outcome, type Trigger } from "./store.js";
import { DailyCapReached, MeteredModel, type WakeDeps } from "./wake.js";

/**
 * Compaction, which is the bot's weekly reflection: its own model looks back
 * over its diary since the last one and its older notes, and rewrites its
 * standing document in four sections (people, threads, positions, to do).
 * The folded notes are then archived (never deleted); the diary stays as it
 * is. Every version of the document is kept, so a bad rewrite can be rolled
 * back from the admin pages. It runs outside wakes, while the bot is asleep,
 * and is logged as a run of its own (kind "compaction").
 */

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/**
 * Whether the bot is due a compaction: "manual" when the admin asked for
 * one, "schedule" when it's asleep and either a week has passed with
 * something to reflect on (notes older than the recent window, or a diary
 * entry a week old that the last reflection didn't see), or its notes have
 * outgrown the limits.
 */
export async function compactionDue(deps: Pick<WakeDeps, "db">, bot: Bot, now: Date): Promise<Trigger | null> {
  if (bot.compactRequestedAt) return "manual";
  const r = config.runner;
  // A bot awake all day compacts whenever it's due; the rest wait for the night.
  const sleeps = bot.schedule.start !== bot.schedule.end;
  if (sleeps && isAwake(now, bot.schedule)) return null;
  const last = await lastCompaction(deps.db, bot.userId);
  if (last.tried && now.getTime() - last.tried.getTime() < r.compaction_retry_hours * HOUR) return null;
  const [stats, oldestDiary] = await Promise.all([noteStats(deps.db, bot.userId, now), diaryOldest(deps.db, bot.userId, last.done)]);
  const every = r.compaction_every_days * DAY;
  const diaryWaiting = oldestDiary !== null && now.getTime() - oldestDiary.getTime() >= every;
  if (stats.count === 0 && !diaryWaiting) return null;
  const oversize = stats.count > r.compaction_max_notes || stats.chars > r.compaction_max_chars;
  const weekly = (stats.old > 0 || diaryWaiting) && (!last.done || now.getTime() - last.done.getTime() >= every);
  return oversize || weekly ? "schedule" : null;
}

/** The standing document's sections, in order, as the reflection writes them. */
export const STANDING_SECTIONS = ["People", "Threads", "Positions", "To do"] as const;

const REFLECTION_BRIEF = `You keep a private notebook for your visits to the board. Your standing notes are the part you carry into every visit. Now and then you look back and rewrite them, and this is that time. Read your diary (what you read and posted, visit by visit), your notes, and your standing notes as they are, and ask yourself what it all adds up to: who you've come to know and what you make of them, which conversations you care about and where they stand, what you've argued and whether you still think it, and what you've promised or meant to do. Then rewrite your standing notes, in your own voice, under exactly these four headings:

## People
A line or two on each member you've dealt with: who they are to you, what they care about, how things stand between you. Keep the quiet ones too, not only the loud.

## Threads
The conversations you care about, by title and thread number, and where each one stands.

## Positions
What you've argued, and where you've changed your mind.

## To do
What you've promised, been asked, or mean to do; or "Nothing" if there's nothing.

Keep what still matters from your old standing notes and let go of what doesn't. Don't invent: if your diary, your notes or your standing notes don't say it, leave it out. Keep usernames exactly as written. Answer with only the new standing notes: no preface, no sign-off.`;

/** The sections a standing document lacks, by heading: "## People", "**People**" or "People:" on a line of its own. */
export function missingSections(body: string): string[] {
  return STANDING_SECTIONS.filter((name) => !new RegExp(`^\\s*(#{1,4}\\s*|\\*\\*)?${name}\\b`, "im").test(body));
}

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
    const [standing, last] = await Promise.all([currentStanding(deps.db, bot.userId), lastCompaction(deps.db, bot.userId)]);
    const [notes, diary] = await Promise.all([
      notesToFold(deps.db, bot.userId, now, trigger === "manual"),
      diarySince(deps.db, bot.userId, last.done, config.runner.reflection_diary_chars),
    ]);
    if (notes.length === 0 && diary.length === 0) {
      await record("skipped", { note: "No notes to fold and no diary since the last reflection." });
      return { outcome: "skipped", runId, pausedUntil: null };
    }
    const headings = STANDING_SECTIONS.map((h) => `## ${h}`).join(", ");
    messages.push(
      {
        role: "system",
        content: `${personaPrompt(bot.personaPrompt) || `You are ${bot.username}.`}\n\n## Your notebook\n\n${REFLECTION_BRIEF}`,
      },
      {
        role: "user",
        content: [
          standing?.body.trim() ? `Your standing notes now:\n${standing.body.trim()}` : "You have no standing notes yet.",
          diary.length
            ? `Your diary ${last.done ? "since your last look back" : "so far"}, oldest first:\n${diary.map((e) => `- ${diaryLine(e)}`).join("\n")}`
            : `No diary entries ${last.done ? "since your last look back" : "yet"}.`,
          notes.length ? `Notes to fold in, oldest first:\n${notes.map((n) => `- ${noteLine(n)}`).join("\n")}` : "No notes to fold in this time.",
          `Write your new standing notes under the four headings, in at most ${max} characters.`,
        ].join("\n\n"),
      }
    );
    let body = "";
    let missing: string[] = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await m.complete({ messages });
      messages.push({ role: "assistant", content: res.content });
      body = unfence(res.content ?? "");
      missing = missingSections(body);
      if (body && body.length <= max && missing.length === 0) break;
      if (attempt === 2) break;
      messages.push({
        role: "user",
        content: !body
          ? "That was empty. Answer with only your new standing notes."
          : body.length > max
            ? `That's ${body.length} characters; the limit is ${max}. Shorten it, keep the four headings (${headings}), and answer with only the notes.`
            : `Put it under the four headings, ${headings}, each on a line of its own, and answer with only the notes.`,
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
    // Sections are asked for, but a document that fits without all of them still beats keeping last week's.
    await record("done", {
      note:
        `Reflected on ${diary.length} diary entr${diary.length === 1 ? "y" : "ies"} and folded ${notes.length} note(s) into the standing notes (${body.length} characters)` +
        (missing.length ? `, without the section${missing.length === 1 ? "" : "s"} ${missing.join(", ")}.` : "."),
    });
    return { outcome: "done", runId, pausedUntil: null };
  } catch (err) {
    const capped = err instanceof DailyCapReached;
    await record("failed", {
      error: capped ? `${err.message} Paused until ${err.until.toISOString()}.` : err instanceof Error ? err.message : String(err),
    });
    return { outcome: "failed", runId, pausedUntil: capped ? err.until : null };
  }
}
