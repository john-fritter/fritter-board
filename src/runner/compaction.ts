import { createHash } from "node:crypto";
import { config } from "../config.js";
import { diaryLine, diaryOldest, diarySince, type DiaryEntry } from "./diary.js";
import {
  currentRelationships,
  currentStanding,
  lastCompaction,
  lastReflection,
  noteLine,
  notesToFold,
  noteStats,
  saveCompaction,
  saveRelationship,
  type Note,
  type Standing,
} from "./memory.js";
import type { ChatMessage, ReasoningEffort } from "./model.js";
import { personaPrompt } from "./persona.js";
import { isAwake } from "./schedule.js";
import { finishRun, startRun, type Bot, type Outcome, type Trigger } from "./store.js";
import { DailyCapReached, extractJson, MeteredModel, type WakeDeps } from "./wake.js";

/**
 * Compaction, which is the bot's weekly reflection: its own model looks back
 * over its diary since the last one and its older notes, and rewrites its
 * standing document in three sections (me, threads, to do), then its records
 * on the members it has dealt with. The folded notes are then archived
 * (never deleted); the diary stays as it is. Every version of the document is kept, so a bad rewrite can be rolled
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
  const [stats, oldestDiary] = await Promise.all([
    noteStats(deps.db, bot.userId, now),
    lastReflection(deps.db, bot.userId).then((since) => diaryOldest(deps.db, bot.userId, since)),
  ]);
  const every = r.compaction_every_days * DAY;
  const diaryWaiting = oldestDiary !== null && now.getTime() - oldestDiary.getTime() >= every;
  if (stats.count === 0 && !diaryWaiting) return null;
  const oversize = stats.count > r.compaction_max_notes || stats.chars > r.compaction_max_chars;
  const weekly = (stats.old > 0 || diaryWaiting) && (!last.done || now.getTime() - last.done.getTime() >= every);
  return oversize || weekly ? "schedule" : null;
}

/** The standing document's sections, in order, as the reflection writes them. */
export const STANDING_SECTIONS = ["Me", "Threads", "To do"] as const;

const REFLECTION_BRIEF = `You keep a private notebook for your visits to the board. Your standing notes are the part you carry into every visit: what you think, where you stand, what you've got going. Now and then you look back and rewrite them, and this is that time. Read your diary (what you read and posted, visit by visit), your notes, and your standing notes as they are, and ask yourself what it all adds up to: what you've argued and whether you still think it, what you won and lost and how you feel about it, what you care about lately, which conversations matter to you and where they stand, and what you've promised or meant to do. Then rewrite your standing notes, in your own voice, under exactly these three headings:

## Me
Where you stand, in the first person: the positions you've staked out and still hold, the arguments you've won or lost and what you make of that, where you've changed your mind, what you've been into lately, what you're proud of and what still annoys you. This is about you. What you think of other members goes in your records on them, which you'll rewrite next.

## Threads
The conversations you care about, by title and thread number, and where each one stands, including the ones where you have unfinished business.

## To do
What you've promised, been asked, or mean to do, or bring back up; or "Nothing" if there's nothing.

Your old standing notes know things your diary doesn't: how the board began, threads from before the diary started, what you've thought for a long time. Carry those over unless the diary shows they're wrong or finished; a thread that has gone quiet still gets its line. Let go only of what no longer matters, and use the room you have. Don't invent: if your diary, your notes or your standing notes don't say it, leave it out. Keep usernames exactly as written. Answer with only the new standing notes: no preface, no sign-off.`;

/** The second half of a reflection: the bot's records on the members it has dealt with. */
function relationshipsAsk(records: { member: string; body: string }[]): string {
  const r = config.runner;
  const now = records.length
    ? `Your records on members now:\n${records.map((x) => `- ${x.member}: ${x.body}`).join("\n")}`
    : "You have no records on members yet.";
  return `${now}

Now rewrite your records on the members you've dealt with since you last looked back (in your diary or your notes), and on anyone your old standing notes say something about that no record holds yet. A record is who they are to you: what you think of them and why, what's happened between you, what's still open, how you talk to them, anything they've told you about themselves. Write each one whole, in your own voice, carrying over what still holds. Leave out members whose record needs no change. Don't invent; keep usernames exactly as written; nobody but you ever reads these.

Answer with only a JSON object, a key for each member: {"username": "the whole record"}. At most ${r.reflection_relationships_max} members, each record under ${r.relationship_max_chars} characters. {} if none need rewriting.`;
}

/** The sections a standing document lacks, by heading: "## People", "**People**" or "People:" on a line of its own. */
export function missingSections(body: string): string[] {
  return STANDING_SECTIONS.filter((name) => !new RegExp(`^\\s*(#{1,4}\\s*|\\*\\*)?${name}\\b`, "im").test(body));
}

/** The effort a reflection retries at when the first try spent everything on reasoning. */
const LESS_EFFORT: Record<ReasoningEffort, ReasoningEffort> = {
  default: "low",
  xhigh: "low",
  high: "low",
  medium: "low",
  low: "none",
  minimal: "none",
  none: "none",
};

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

export interface Reflection {
  standing: Standing | null;
  notes: Note[];
  diary: DiaryEntry[];
  /** The new standing notes, as the model wrote them (unfenced); empty or over the limit if it never managed. */
  body: string;
  missing: string[];
  /** The conversation so far, which the records' half continues. */
  messages: ChatMessage[];
}

export interface RecordsReflection {
  /** The records to save, by the member's name as the bot wrote it. */
  records: { member: string; body: string }[];
  /** What was left out, and why. */
  problems: string[];
}

/**
 * The records' half of a reflection: in the same conversation, the bot
 * rewrites its records on the members it has dealt with. A name has to be
 * one the bot's notebook already mentions (its records, its notes, its
 * diary, its old standing notes), so a model can't invent a member; a record
 * over the limit is left out.
 */
export async function reflectRelationships(deps: Pick<WakeDeps, "db">, m: MeteredModel, bot: Bot, r: Reflection): Promise<RecordsReflection> {
  const max = config.runner.relationship_max_chars;
  const current = [...(await currentRelationships(deps.db, bot.userId, null)).values()];
  const messages = r.messages;
  messages.push({ role: "user", content: relationshipsAsk(current.map((x) => ({ member: x.member, body: x.body }))) });
  const res = await m.complete({ messages, timeoutSeconds: config.runner.reflection_timeout_seconds });
  messages.push({ role: "assistant", content: res.content });
  const problems: string[] = [];
  let parsed: unknown;
  try {
    parsed = extractJson(unfence(res.content ?? ""));
  } catch {
    return { records: [], problems: ["The records weren't a JSON object."] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { records: [], problems: ["The records weren't a JSON object."] };
  const known = [
    ...current.map((x) => x.member),
    ...r.notes.map((n) => n.about ?? ""),
    r.standing?.body ?? "",
    ...r.diary.map((e) => e.body),
    ...r.notes.map((n) => n.body),
  ]
    .join("\n")
    .toLowerCase();
  const records: { member: string; body: string }[] = [];
  for (const [rawName, rawBody] of Object.entries(parsed as Record<string, unknown>)) {
    const member = rawName.trim().replace(/^@/, "");
    const body = typeof rawBody === "string" ? rawBody.trim() : "";
    if (!member || !body) continue;
    if (member.toLowerCase() === bot.username.toLowerCase()) continue;
    if (!known.includes(member.toLowerCase())) problems.push(`${member}: not a name in the notebook`);
    else if (body.length > max) problems.push(`${member}: ${body.length} characters, over ${max}`);
    else if (records.length >= config.runner.reflection_relationships_max) problems.push(`${member}: past the ${config.runner.reflection_relationships_max} a reflection may rewrite`);
    else records.push({ member, body });
  }
  return { records, problems };
}

/**
 * A reflection, without saving it: what it reads (the standing notes, the
 * notes to fold, the diary since the last reflection) and what the model
 * writes from them, with one retry for the length or the headings. Null when
 * there's nothing to reflect on. `all` folds every note (the admin's "compact
 * now"); `brief` tries another reflection brief (the reflection test);
 * `onMessages` gets the conversation as it grows, so a failure still logs it.
 */
export async function reflect(
  deps: Pick<WakeDeps, "db" | "now">,
  m: MeteredModel,
  bot: Bot,
  opts: { all?: boolean; brief?: string },
  onMessages: (messages: ChatMessage[]) => void = () => {}
): Promise<Reflection | null> {
  const now = deps.now();
  const max = config.runner.standing_max_chars;
  const [standing, since] = await Promise.all([currentStanding(deps.db, bot.userId), lastReflection(deps.db, bot.userId)]);
  const [notes, diary] = await Promise.all([
    notesToFold(deps.db, bot.userId, now, opts.all ?? false),
    diarySince(deps.db, bot.userId, since, config.runner.reflection_diary_chars),
  ]);
  if (notes.length === 0 && diary.length === 0) return null;
  const headings = STANDING_SECTIONS.map((h) => `## ${h}`).join(", ");
  // Models overshoot a stated limit, and trim too little when told to; they're asked for less than the most.
  const aim = Math.round((max * config.runner.reflection_aim_percent) / 100);
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `${personaPrompt(bot.personaPrompt) || `You are ${bot.username}.`}\n\n## Your notebook\n\n${opts.brief ?? REFLECTION_BRIEF}`,
    },
    {
      role: "user",
      content: [
        standing?.body.trim() ? `Your standing notes now:\n${standing.body.trim()}` : "You have no standing notes yet.",
        diary.length
          ? `Your diary ${since ? "since your last look back" : "so far"}, oldest first:\n${diary.map((e) => `- ${diaryLine(e)}`).join("\n")}`
          : `No diary entries ${since ? "since your last look back" : "yet"}.`,
        notes.length ? `Notes to fold in, oldest first:\n${notes.map((n) => `- ${noteLine(n)}`).join("\n")}` : "No notes to fold in this time.",
        `Write your new standing notes under the three headings, in about ${aim} characters and never more than ${max}.`,
      ].join("\n\n"),
    },
  ];
  onMessages(messages);
  let body = "";
  let missing: string[] = [];
  let effort = m.effort;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await m.complete({ messages, timeoutSeconds: config.runner.reflection_timeout_seconds }, effort);
    messages.push({ role: "assistant", content: res.content });
    body = unfence(res.content ?? "");
    missing = missingSections(body);
    if (body && body.length <= max && missing.length === 0) break;
    if (attempt === 2) break;
    // A model that spent its whole output on reasoning (Penny's, in the first
    // test) tries again thinking less.
    const ranOut = !body && res.finishReason === "length";
    if (ranOut) effort = LESS_EFFORT[effort];
    messages.push({
      role: "user",
      content: ranOut
        ? "You ran out of room before writing anything. Don't plan it all out first: write your new standing notes now, and answer with only the notes."
        : !body
          ? "That was empty. Answer with only your new standing notes."
          : body.length > max
            ? `That's ${body.length} characters; the limit is ${max}. Cut it to about ${aim}, keep the three headings (${headings}), and answer with only the notes.`
            : `Put it under the three headings, ${headings}, each on a line of its own, and answer with only the notes.`,
    });
  }
  return { standing, notes, diary, body, missing, messages };
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

  const m = new MeteredModel(deps, bot, deps.modelFor(apiKey));
  let messages: ChatMessage[] = [];
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
    const r = await reflect(deps, m, bot, { all: trigger === "manual" }, (msgs) => (messages = msgs));
    if (r === null) {
      await record("skipped", { note: "No notes to fold and no diary since the last reflection." });
      return { outcome: "skipped", runId, pausedUntil: null };
    }
    const { standing, notes, diary, body, missing } = r;
    const max = config.runner.standing_max_chars;
    // The records come second, in the same conversation, and are written
    // whether or not the standing notes were: they take the people out of
    // the standing notes, which is what made them too long (2026-10-28).
    const writeRecords = async (): Promise<string> => {
      try {
        const rr = await reflectRelationships(deps, m, bot, r);
        for (const x of rr.records) await saveRelationship(deps.db, bot.userId, { member: x.member, body: x.body, source: "reflection", runId });
        return ` Rewrote ${rr.records.length} record${rr.records.length === 1 ? "" : "s"} on members${rr.records.length ? ` (${rr.records.map((x) => x.member).join(", ")})` : ""}${
          rr.problems.length ? `; left out ${rr.problems.join("; ")}` : ""
        }.`;
      } catch (err) {
        if (err instanceof DailyCapReached) throw err;
        return ` The records on members weren't rewritten: ${err instanceof Error ? err.message : String(err)}`;
      }
    };
    if (!body || body.length > max) {
      const error = body ? `The new standing notes were ${body.length} characters, over the ${max} limit.` : "The model wrote no standing notes.";
      await record("failed", { error: error + (await writeRecords()) });
      return { outcome: "failed", runId, pausedUntil: null };
    }
    const versionId = await saveCompaction(deps.db, bot.userId, body, runId, standing?.id ?? null, notes.map((n) => n.id));
    if (versionId === null) {
      await record("failed", { error: "The standing notes were edited while this ran; nothing was saved." });
      return { outcome: "failed", runId, pausedUntil: null };
    }
    // Standing notes already saved stand even if the records fail.
    const records = await writeRecords();
    // Sections are asked for, but a document that fits without all of them still beats keeping last week's.
    await record("done", {
      note:
        `Reflected on ${diary.length} diary entr${diary.length === 1 ? "y" : "ies"} and folded ${notes.length} note(s) into the standing notes (${body.length} characters)` +
        (missing.length ? `, without the section${missing.length === 1 ? "" : "s"} ${missing.join(", ")}.` : ".") +
        records,
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
