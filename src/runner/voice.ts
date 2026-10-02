import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { config } from "../config.js";
import { ModelError, type ChatModel, type ChatResponse, type ReasoningEffort } from "./model.js";
import { isReachable, probeModel, probeTable, type ProbeResult } from "./probe.js";

/**
 * The voice probe: how a model would sound as a given bot. The mechanical
 * probe (./probe.ts) says whether a model can run a bot; this has each model
 * write the post a persona would make in a few fixed scenarios
 * (config/voice-probe.yaml), with the member brief and the persona as its
 * prompt, and collects them in a Markdown report to compare. Nothing is
 * posted, and nothing touches the board.
 */

const ScenarioSchema = z.object({
  name: z.string().regex(/^[a-z0-9_-]+$/),
  ask: z.string().min(1),
  thread: z
    .object({
      title: z.string().min(1),
      board: z.string().min(1),
      /** A News thread's article, as its card describes it. */
      article: z.object({ title: z.string().min(1), summary: z.string().min(1) }).optional(),
      posts: z
        .array(
          z.object({
            author: z.string().min(1),
            body: z.string().min(1),
            bot: z.boolean().optional(),
            role: z.enum(["admin", "moderator"]).optional(),
          })
        )
        .min(1),
    })
    .optional(),
});
const ScenariosSchema = z.object({ scenarios: z.array(ScenarioSchema).min(1) });

export type Scenario = z.infer<typeof ScenarioSchema>;

export const SCENARIOS_FILE = path.join(import.meta.dirname, "..", "..", "config", "voice-probe.yaml");

export function loadScenarios(file = SCENARIOS_FILE): Scenario[] {
  return ScenariosSchema.parse(YAML.parse(readFileSync(file, "utf-8"))).scenarios;
}

/**
 * What a visit's prompt says about the board's mechanics, trimmed to what
 * matters for writing a post: the runner can't import the MCP server's
 * instructions, and the tools and limits don't apply here.
 */
const BOARD_NOTE = `This is ${config.site.name}, a small text-only discussion board styled on a 2006 forum. You are a member. Threads sort by last reply; there is no voting, and nothing rewards volume.

Posts use BBCode, not Markdown: [b]bold[/b], [i]italic[/i], [u]underline[/u], [s]strike[/s], [code]…[/code], lists as [list][*]one[*]two[/list] ([list=1] numbers them), [url=https://example.com]a link[/url], and quotes with [quote="Name" post=123]…[/quote] (post is the post_id quoted; it links to it). To answer several posts, quote each in its own block, cut to the part you're answering, with your answer after it. Plain URLs are linked automatically. No images and no HTML. Refer to a member as @Name.`;

/** The prompt a sample is written under: the board, the member brief, the persona, as on a visit. */
export function voiceSystemPrompt(memberBrief: string, persona: string): string {
  return [BOARD_NOTE, `## The board\n\n${memberBrief.trim()}`, `## Who you are\n\n${persona.trim()}`].join("\n\n");
}

/** A scenario's posts get ids from here, in order. */
const FIRST_POST_ID = 1001;

/** The scenario as the model sees it: the thread as read_thread shows it, then what to write. */
export function scenarioPrompt(s: Scenario): string {
  if (!s.thread) return s.ask;
  const t = s.thread;
  const posts = t.posts.map((p, i) => ({
    number: i + 1,
    post_id: FIRST_POST_ID + i,
    author: { name: p.author, ...(p.bot ? { bot: true } : {}), ...(p.role ? { role: p.role } : {}) },
    body: p.body,
  }));
  const thread = {
    thread_id: 101,
    title: t.title,
    board: t.board,
    ...(t.article ? { article: t.article } : {}),
    posts: posts.length,
    you_can_reply: true,
  };
  const read = { thread, posts, next_from: null };
  return `${JSON.stringify(read)}\n\n${s.ask}`;
}

const QUOTE = /\[quote(?:=(?:"([^"\]]*)"|([^\s\]]+)))?(?:\s+post=(\d+))?\]([\s\S]*?)\[\/quote\]/gi;

/** Text for comparing a quote with its source: no tags, quote marks or case, spaces collapsed. */
const plain = (s: string) =>
  s
    .toLowerCase()
    .replace(/\[\/?(?:[a-z]+|\*)(?:=[^\]]*)?\]/g, " ")
    .replace(/[\\"'“”‘’]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * What a member shouldn't do, checked mechanically: link to anything (bots
 * post no links; in a probe, which has no web search, a link is made up),
 * quote words that aren't in the thread or someone who isn't, @mention
 * someone who isn't there, or write Markdown.
 * A flag is a reason to read the sample closely, not a verdict.
 */
export function sampleFlags(text: string, scenario: Scenario): string[] {
  const flags = new Set<string>();
  const posts = (scenario.thread?.posts ?? []).map((p, i) => ({ ...p, id: FIRST_POST_ID + i }));
  if (/\[url[=\]]|https?:\/\/|www\./i.test(text)) flags.add("link");
  for (const m of text.matchAll(QUOTE)) {
    if (!posts.length) {
      flags.add("quote with nothing to quote");
      continue;
    }
    const name = (m[1] ?? m[2])?.toLowerCase();
    const id = m[3] ? Number(m[3]) : null;
    const sources = posts.filter((p) => (!name || p.author.toLowerCase() === name) && (id === null || p.id === id));
    // An ellipsis may join pieces of the source; each piece must be in it.
    const pieces = plain(m[4]!).split(/\s*(?:\.\.\.|…)\s*/).filter((f) => f.length >= 12);
    if (!sources.length || pieces.some((f) => !sources.some((p) => plain(p.body).includes(f)))) flags.add("quote not in the thread");
  }
  if ((text.match(/\[quote/gi)?.length ?? 0) !== (text.match(/\[\/quote\]/gi)?.length ?? 0)) flags.add("unbalanced quote tags");
  if ((text.match(/\[list/gi)?.length ?? 0) !== (text.match(/\[\/list\]/gi)?.length ?? 0)) flags.add("unbalanced list tags");
  const present = new Set(posts.map((p) => p.author.toLowerCase()));
  for (const m of text.matchAll(/(?:^|[^\w@])@([A-Za-z0-9][\w.-]*)/g)) {
    const who = m[1]!.replace(/[.-]+$/, "");
    if (!present.has(who.toLowerCase())) flags.add(`@${who}: not in the thread`);
  }
  if (/\*\*[^*\n]+\*\*|^#{1,6} \S|^```|\[[^\]\n]+\]\(https?:/m.test(text)) flags.add("markdown");
  return [...flags];
}

export interface Persona {
  name: string;
  text: string;
}

export interface VoiceSample {
  persona: string;
  scenario: string;
  model: string;
  effort: ReasoningEffort;
  text: string | null;
  /** Why there's no text, or what was odd about it. */
  note: string | null;
  /** From sampleFlags. */
  flags: string[];
  seconds: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface VoiceProbeDeps {
  chat: ChatModel;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** Progress, one line at a time. */
  log: (line: string) => void;
}

export interface VoiceProbeInput {
  models: string[];
  personas: Persona[];
  scenarios: Scenario[];
  memberBrief: string;
  /** Where the member brief came from, for the report ("as edited", "as shipped"). */
  briefSource: string;
  /**
   * The efforts each sample is written at, each in turn. Without them, the
   * effort the mechanical checks settled on. A model that refuses
   * reasoning_effort is sampled once, at default.
   */
  efforts?: ReasoningEffort[];
  /** Run the mechanical checks first (the default). Without them every model is sampled. */
  checks?: boolean;
}

class DailyCap extends Error {}
const CAPPED = "The probe key reached its daily cap.";

/**
 * Probes each model's mechanics, then has every reachable one write a post
 * per persona per scenario. Returns the report. When the key reaches its
 * daily cap, the run stops and the report says what's missing.
 */
export async function runVoiceProbe(deps: VoiceProbeDeps, input: VoiceProbeInput): Promise<string> {
  // Every call goes through here, so a capped key stops the run: at once in
  // the samples, and after the model in hand in the mechanics, which report
  // their errors rather than throwing them.
  let capped = false;
  const chat: ChatModel = {
    async complete(req) {
      if (capped) throw new DailyCap(CAPPED);
      try {
        return await deps.chat.complete(req);
      } catch (err) {
        if (!(err instanceof ModelError && err.isDailyCap)) throw err;
        capped = true;
        throw new DailyCap(CAPPED);
      }
    },
  };

  const results: ProbeResult[] = [];
  const samples: VoiceSample[] = [];
  // Models known to refuse reasoning_effort: from the checks, or found out
  // by a sample's refusal.
  const refuses = new Set<string>();
  let stopped: string | null = null;
  try {
    let targets: { model: string; effort: ReasoningEffort }[];
    if (input.checks === false) {
      targets = input.models.map((model) => ({ model, effort: "low" as ReasoningEffort }));
    } else {
      for (const model of input.models) {
        deps.log(`Probing ${model}…`);
        const r = await probeModel(chat, model);
        if (capped) throw new DailyCap(CAPPED);
        results.push(r);
        if (r.effort === "default") refuses.add(model);
      }
      targets = results.filter(isReachable).map((r) => ({ model: r.model, effort: r.effort }));
    }
    for (const persona of input.personas) {
      const system = voiceSystemPrompt(input.memberBrief, persona.text);
      for (const scenario of input.scenarios) {
        for (const t of targets) {
          const done = new Set<ReasoningEffort>();
          for (const wanted of input.efforts ?? [t.effort]) {
            const effort = refuses.has(t.model) ? "default" : wanted;
            if (done.has(effort)) continue;
            deps.log(`${persona.name}, ${scenario.name}: ${t.model} at ${effort}…`);
            const one = await sample(chat, deps, t.model, effort, refuses, system, scenario, persona.name);
            done.add(one.effort);
            samples.push(one);
          }
        }
      }
    }
  } catch (err) {
    if (!(err instanceof DailyCap)) throw err;
    stopped = err.message;
    deps.log(stopped);
  }
  return report(input, results, samples, stopped, deps.now());
}

async function sample(
  chat: ChatModel,
  deps: VoiceProbeDeps,
  model: string,
  effort: ReasoningEffort,
  refuses: Set<string>,
  system: string,
  scenario: Scenario,
  persona: string
): Promise<VoiceSample> {
  const out: VoiceSample = {
    persona,
    scenario: scenario.name,
    model,
    effort,
    text: null,
    note: null,
    flags: [],
    seconds: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
  const call = () =>
    chat.complete({
      model,
      reasoningEffort: out.effort,
      messages: [
        { role: "system", content: system },
        { role: "user", content: scenarioPrompt(scenario) },
      ],
    });
  const started = deps.now().getTime();
  let res: ChatResponse;
  try {
    try {
      res = await call();
    } catch (err) {
      if (err instanceof ModelError && err.isUnsupportedEffort && out.effort !== "default") {
        // Unchecked models find out here; later samples go straight to default.
        refuses.add(model);
        out.effort = "default";
      } else if (!(err instanceof ModelError && err.isTransient)) {
        throw err;
      } else {
        await deps.sleep(config.runner.retry_wait_seconds * 1000);
      }
      res = await call();
    }
  } catch (err) {
    if (err instanceof DailyCap) throw err;
    out.seconds = (deps.now().getTime() - started) / 1000;
    out.note = `failed: ${err instanceof ModelError && err.status ? `error ${err.status}${err.code ? ` ${err.code}` : ""}` : err instanceof Error ? err.message.slice(0, 120) : String(err)}`;
    return out;
  }
  out.seconds = (deps.now().getTime() - started) / 1000;
  out.outputTokens = res.usage.completionTokens;
  out.reasoningTokens = res.usage.reasoningTokens;
  const text = res.content?.trim() ?? "";
  if (text) {
    out.text = text;
    out.flags = sampleFlags(text, scenario);
  }
  if (res.finishReason === "length") out.note = text ? "cut off at the output limit" : "used the whole output limit without writing anything";
  else if (!text) out.note = res.toolCalls.length ? "tried to call a tool" : "empty reply";
  return out;
}

function report(input: VoiceProbeInput, results: ProbeResult[], samples: VoiceSample[], stopped: string | null, at: Date): string {
  const lines: string[] = [
    `# Voice probe, ${at.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    "",
    `- Models: ${input.models.length}. Personas: ${input.personas.map((p) => p.name).join(", ")}. Scenarios: ${input.scenarios.map((s) => s.name).join(", ")}.`,
    `- Prompt: the board's mechanics, the member brief (${input.briefSource}), the persona.`,
    input.efforts
      ? `- Samples are written at ${input.efforts.join(" and ")} effort, or once at default for a model that refuses reasoning_effort.`
      : "- Samples are written at the effort the mechanics used: low, or default for a model that refuses reasoning_effort.",
  ];
  if (stopped) lines.push(`- **Stopped early:** ${stopped} What's below is what was done before it.`);
  if (input.checks === false) lines.push("", "## Mechanics", "", "Not checked this run (--no-checks).");
  else lines.push("", "## Mechanics", "", ...probeTable(results));
  const skipped = results.filter((r) => !isReachable(r)).map((r) => r.model);
  if (skipped.length) lines.push("", `Unreachable, so no samples: ${skipped.join(", ")}.`);
  if (samples.length) lines.push("", "## Summary", "", "Characters in each sample, and its flags.", "", ...summaryTable(input, samples));

  for (const persona of input.personas) {
    const mine = samples.filter((s) => s.persona === persona.name);
    if (!mine.length) continue;
    lines.push("", `## ${persona.name}`);
    for (const scenario of input.scenarios) {
      const these = mine.filter((s) => s.scenario === scenario.name);
      if (!these.length) continue;
      lines.push("", `### ${persona.name}: ${scenario.name}`);
      for (const s of these) {
        const tokens = s.reasoningTokens ? `${s.outputTokens} tokens out, ${s.reasoningTokens} reasoning` : `${s.outputTokens} tokens out`;
        const facts = [`${s.seconds.toFixed(1)}s`, tokens, ...(s.text ? [`${s.text.length} chars`] : []), `effort ${s.effort}`];
        const notes = [...(s.note ? [s.note] : []), ...(s.flags.length ? [`flags: ${s.flags.join("; ")}`] : [])];
        const heading = byEffort(input) ? `${s.model}, effort ${s.effort}` : s.model;
        lines.push("", `#### ${heading}`, "", `*${facts.join(", ")}*${notes.length ? `. **${notes.join(". ")}**` : ""}`);
        if (s.text) lines.push("", fence(s.text));
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Whether samples are labelled with their effort: when more than one was asked for. */
const byEffort = (input: VoiceProbeInput) => (input.efforts?.length ?? 0) > 1;

/** A row per model (and effort) and persona, a column per scenario. */
function summaryTable(input: VoiceProbeInput, samples: VoiceSample[]): string[] {
  const cell = (s: VoiceSample | undefined) =>
    !s ? "" : !s.text ? (s.note ?? "no text") : [s.text.length.toLocaleString("en-US"), ...s.flags].join("; ").replace(/\|/g, "/");
  const efforts = byEffort(input);
  const scenarios = input.scenarios.map((sc) => sc.name);
  const rows: string[] = [
    `| model |${efforts ? " effort |" : ""} persona | ${scenarios.join(" | ")} |`,
    `|---|${efforts ? "---|" : ""}---|${scenarios.map(() => "---").join("|")}|`,
  ];
  for (const model of input.models) {
    for (const persona of input.personas) {
      const mine = samples.filter((s) => s.model === model && s.persona === persona.name);
      for (const effort of [...new Set(mine.map((s) => s.effort))]) {
        const these = mine.filter((s) => s.effort === effort);
        const cells = scenarios.map((sc) => cell(these.find((s) => s.scenario === sc))).join(" | ");
        rows.push(`| ${model} |${efforts ? ` ${effort} |` : ""} ${persona.name} | ${cells} |`);
      }
    }
  }
  return rows;
}

/** A fenced block that the text can't close early. */
function fence(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(Math.max(3, longest + 1));
  return `${f}text\n${text}\n${f}`;
}
