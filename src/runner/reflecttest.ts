import { config } from "../config.js";
import { reflect, reflectRelationships, type RecordsReflection, type Reflection } from "./compaction.js";
import { diaryLine } from "./diary.js";
import { noteLine } from "./memory.js";
import type { ChatModel } from "./model.js";
import type { Bot, Db } from "./store.js";
import { MeteredModel, type WakeDeps } from "./wake.js";

/**
 * The reflection test (npm run runner -- reflect-test): each bot's weekly
 * reflection run now, on its own model but a test key, with what it would
 * read and what it would write set next to its standing notes as they are.
 * Nothing is saved: no run, no new version, no note archived.
 */

export interface ReflectTestDeps {
  db: Db;
  chat: ChatModel;
  now(): Date;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

interface Outcome {
  bot: Bot;
  r: Reflection | null;
  records: RecordsReflection | null;
  calls: number;
  tokens: { prompt: number; completion: number };
  error: string | null;
}

const fence = (text: string) => ["````text", text.trim() || "(empty)", "````"].join("\n");

export async function runReflectTest(deps: ReflectTestDeps, bots: Bot[], opts: { brief?: string; briefSource: string }): Promise<string> {
  // MeteredModel needs only the clock and the sleep; the rest of a wake's deps are never touched.
  const wakeDeps = { db: deps.db, now: deps.now, sleep: deps.sleep } as unknown as WakeDeps;
  const outcomes: Outcome[] = [];
  for (const bot of bots) {
    deps.log(`${bot.username}: reflecting on ${bot.model}`);
    const m = new MeteredModel(wakeDeps, bot, deps.chat);
    let r: Reflection | null = null;
    let records: RecordsReflection | null = null;
    let error: string | null = null;
    try {
      r = await reflect(wakeDeps, m, bot, opts.brief ? { brief: opts.brief } : {});
      if (r?.body) records = await reflectRelationships(wakeDeps, m, bot, r);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    outcomes.push({ bot, r, records, calls: m.modelCalls, tokens: { prompt: m.usage.promptTokens, completion: m.usage.completionTokens }, error });
  }

  const max = config.runner.standing_max_chars;
  const lines = [
    "# Reflection test",
    "",
    `Run ${deps.now().toISOString()}. Reflection brief ${opts.briefSource}. Each bot on its own model at its own effort; nothing was saved.`,
    "",
    "| Bot | Model | Diary entries | Notes to fold | Now (chars) | New (chars) | Missing sections | Records | Calls | Tokens in/out | Result |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...outcomes.map(({ bot, r, records, calls, tokens, error }) => {
      const result = error ? "error" : !r ? "nothing to reflect on" : !r.body ? "empty" : r.body.length > max ? "too long" : "ok";
      return `| ${bot.username} | ${bot.model} | ${r?.diary.length ?? "-"} | ${r?.notes.length ?? "-"} | ${r?.standing?.body.length ?? 0} | ${r?.body.length ?? "-"} | ${
        r?.missing.join(", ") || "-"
      } | ${records ? `${records.records.length}${records.problems.length ? ` (${records.problems.length} left out)` : ""}` : "-"} | ${calls} | ${tokens.prompt}/${tokens.completion} | ${result} |`;
    }),
  ];
  for (const { bot, r, records, error } of outcomes) {
    lines.push("", `## ${bot.username}`, "");
    if (error) {
      lines.push(`Failed: ${error}`);
      continue;
    }
    if (!r) {
      lines.push("Nothing to reflect on: no notes to fold and no diary since the last reflection.");
      continue;
    }
    lines.push("### New standing notes", "", fence(r.body), "", "### Standing notes now", "", fence(r.standing?.body ?? "(none yet)"));
    if (records) {
      lines.push("", `### Records on members: ${records.records.length} rewritten`, "");
      lines.push(fence([...records.records.map((x) => `- ${x.member}: ${x.body}`), ...(records.problems.length ? ["", "Left out:", ...records.problems.map((p) => `- ${p}`)] : [])].join("\n")));
    }
    lines.push("", `### What it read: ${r.diary.length} diary entr${r.diary.length === 1 ? "y" : "ies"}, ${r.notes.length} note(s)`, "");
    lines.push(fence([...r.diary.map((e) => `- ${diaryLine(e)}`), ...(r.notes.length ? ["", "Notes:", ...r.notes.map((n) => `- ${noteLine(n)}`)] : [])].join("\n")));
  }
  return `${lines.join("\n")}\n`;
}
