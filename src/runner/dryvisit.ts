import { config } from "../config.js";
import { loadPatterns, measurePost, median, onLength } from "./measure.js";
import { parsePersona } from "./persona.js";
import type { Bot } from "./store.js";
import { runWake, type Draft, type WakeDeps, type WakeResult } from "./wake.js";

/**
 * Dry visits (npm run runner -- dry-visit): each bot through a whole visit
 * against the live board, as itself, with its real inbox and notebook, on a
 * test key, over a look-only connection. What it would have posted, sent or
 * noted comes back in a Markdown report, measured like the voice metrics; the
 * board gets nothing, nothing is marked read, and the bot's cursor, side and
 * day's counts don't move. It tests what sample posts can't: where a bot goes
 * and what it does there when a side sends it somewhere.
 */

export interface DryVisitInput {
  bots: Bot[];
  apiKey: string;
  /** "pick": one visit a bot, side by weight; "each": a visit per side; or a side's name. */
  sides: "pick" | "each" | string;
  /** Persona texts to try instead of the bots' own, by username. */
  personas: Map<string, string>;
  personaSource: string;
  memberBrief?: string;
  briefSource: string;
  /** Visits as a newcomer, with none of the bots' own memory (DryVisit.fresh). */
  fresh?: boolean;
}

interface Visit {
  bot: string;
  /** The side asked for, if any. */
  wanted: string | null;
  result: WakeResult | null;
  error: string | null;
  note: string | null;
  modelCalls: number;
}

export async function runDryVisits(deps: WakeDeps & { log: (line: string) => void }, input: DryVisitInput): Promise<string> {
  const visits: Visit[] = [];
  for (const bot of input.bots) {
    const persona = input.personas.get(bot.username) ?? bot.personaPrompt;
    const { sides } = parsePersona(persona);
    const wanted: (string | null)[] =
      input.sides === "each" ? (sides.length ? sides.map((s) => s.name) : [null]) : input.sides === "pick" ? [null] : [input.sides];
    for (const side of wanted) {
      deps.log(`${bot.username}${side ? `, ${side}` : ""}…`);
      const visit: Visit = { bot: bot.username, wanted: side, result: null, error: null, note: null, modelCalls: 0 };
      try {
        visit.result = await runWake(deps, bot, "manual", {
          dry: {
            apiKey: input.apiKey,
            ...(side ? { side } : {}),
            ...(input.personas.has(bot.username) ? { persona: persona } : {}),
            ...(input.memberBrief !== undefined ? { memberBrief: input.memberBrief } : {}),
            ...(input.fresh ? { fresh: true } : {}),
          },
        });
        const { rows } = await deps.db.query<{ note: string | null; error: string | null; model_calls: number }>(
          "SELECT note, error, model_calls FROM bots.runs WHERE id = $1",
          [visit.result.runId]
        );
        visit.note = rows[0]?.note ?? null;
        visit.error = rows[0]?.error ?? null;
        visit.modelCalls = rows[0]?.model_calls ?? 0;
      } catch (err) {
        visit.error = err instanceof Error ? err.message : String(err);
      }
      visits.push(visit);
    }
  }
  return report(input, visits, deps.now());
}

const POSTS = new Set(["reply", "new_thread", "edit_post"]);

function where(d: Draft): string {
  const board = d.board ? ` in ${d.board}` : "";
  if (d.tool === "reply") return `reply to thread ${String(d.args["thread_id"])}${board}`;
  if (d.tool === "new_thread") return `new thread${board}: "${String(d.args["title"] ?? "")}"`;
  if (d.tool === "edit_post") return `edit of post ${String(d.args["post_id"])}${board}`;
  if (d.tool === "send_pm") return d.args["conversation_id"] ? `PM in conversation ${String(d.args["conversation_id"])}` : `PM to ${String(d.args["to"] ?? "?")}`;
  if (d.tool === "remember") return `note${d.args["about"] ? ` about ${String(d.args["about"])}` : ""}`;
  if (d.tool === "set_own_title") return "title change";
  if (d.tool === "update_relationship") return `record on ${String(d.args["member"] ?? "?")}`;
  if (d.tool === "mood") return "mood at the end";
  return d.tool.replace(/_/g, " ");
}

const body = (d: Draft) =>
  String(d.args["body"] ?? d.args["text"] ?? d.args["record"] ?? d.args["mood"] ?? d.args["title"] ?? d.args["reason"] ?? "");
const cell = (s: string) => s.replace(/\|/g, "/").replace(/\n/g, " ");
const pct = (n: number, of: number) => (of === 0 ? "-" : `${Math.round((n / of) * 100)}%`);

function fence(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(Math.max(3, longest + 1));
  return `${f}text\n${text}\n${f}`;
}

function report(input: DryVisitInput, visits: Visit[], at: Date): string {
  const patterns = loadPatterns();
  const tolerance = config.runner.length_tolerance;
  const lines = [
    `# Dry visits, ${at.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    "",
    `- Bots: ${input.bots.map((b) => b.username).join(", ")}. ${input.sides === "each" ? "One visit per side." : input.sides === "pick" ? "One visit each, side picked by weight." : `Side: ${input.sides}.`}`,
    `- Personas: ${input.personaSource}. Member brief: ${input.briefSource}.`,
    "- Each visit ran as the bot, with its real inbox and notebook, on the test key, over a look-only connection: nothing was posted, sent, noted or marked read, and no web searches were made.",
    `- Words are each post's own, quotes left out. "On length" is within ${Math.round(tolerance * 100)}% of what the visit asked for.`,
    "",
    "## Summary",
    "",
    "| bot | side | asked | posts (words) | on length | where | PMs | notes | opens with quote | quote and praise | outcome |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const v of visits) {
    const r = v.result;
    const drafts = r?.drafts ?? [];
    const posts = drafts.filter((d) => POSTS.has(d.tool) || d.tool === "send_pm");
    const measured = posts.map((d) => measurePost(body(d), patterns));
    const asked = r?.voice?.words ?? null;
    const words = measured.map((m) => m.words);
    lines.push(
      `| ${cell(v.bot)} | ${cell(r?.voice?.side.name ?? v.wanted ?? "-")} | ${asked ?? "-"} | ${posts.length ? `${posts.length} (${words.join(", ")})` : "0"} | ${
        asked && words.length ? pct(words.filter((w) => onLength(w, asked, tolerance)).length, words.length) : "-"
      } | ${cell(drafts.filter((d) => POSTS.has(d.tool)).map((d) => (d.tool === "new_thread" ? `new thread in ${d.board ?? "?"}` : (d.board ?? "?"))).join(", ") || "-")} | ${
        drafts.filter((d) => d.tool === "send_pm").length
      } | ${drafts.filter((d) => d.tool === "remember").length} | ${measured.filter((m) => m.opensWithQuote).length} | ${measured.filter((m) => m.praise.length).length} | ${
        v.error ? "failed" : (r?.outcome ?? "-")
      } |`
    );
  }
  const all = visits.flatMap((v) =>
    (v.result?.drafts ?? []).filter((d) => POSTS.has(d.tool) || d.tool === "send_pm").map((d) => ({ asked: v.result?.voice?.words ?? null, m: measurePost(body(d), patterns) }))
  );
  if (all.length) {
    const asked = all.filter((a) => a.asked !== null);
    lines.push(
      "",
      `All visits: ${all.length} posts and messages, median ${median(all.map((a) => a.m.words))} words; ${
        asked.length ? `${pct(asked.filter((a) => onLength(a.m.words, a.asked!, tolerance)).length, asked.length)} on length; ` : ""
      }${pct(all.filter((a) => a.m.opensWithQuote).length, all.length)} open with a quote; ${pct(all.filter((a) => a.m.praise.length).length, all.length)} quote and praise.`
    );
  }

  for (const v of visits) {
    const r = v.result;
    lines.push("", `## ${v.bot}${r?.voice ? `: ${r.voice.side.name}, about ${r.voice.words} words` : v.wanted ? `: ${v.wanted}` : ""}`, "");
    lines.push(`*${[r ? `run #${r.runId}` : null, `${v.modelCalls} model call${v.modelCalls === 1 ? "" : "s"}`, v.error ? "failed" : (r?.outcome ?? null)].filter(Boolean).join(" · ")}*`);
    if (v.error) lines.push("", `**Error:** ${v.error}`);
    const drafts = r?.drafts ?? [];
    if (!drafts.length && !v.error) lines.push("", "Wrote nothing.");
    for (const d of drafts) {
      const text = body(d);
      const m = POSTS.has(d.tool) || d.tool === "send_pm" ? measurePost(text, patterns) : null;
      const facts = m
        ? [
            `${m.words} words`,
            ...(m.opensWithQuote ? ["opens with a quote"] : []),
            ...(m.praise.length ? [`quote and praise: ${m.praise.join(", ")}`] : []),
            ...(m.phrases.length ? [`house phrases: ${m.phrases.join(", ")}`] : []),
          ]
        : [];
      lines.push("", `### ${where(d)}${facts.length ? ` · ${facts.join(" · ")}` : ""}`, "", fence(text));
    }
    if (v.note) lines.push("", `Its note: ${v.note}`);
  }
  return `${lines.join("\n")}\n`;
}
