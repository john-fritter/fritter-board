import { config } from "../config.js";
import { loadPatterns, measurePost, median, onLength, type PostMeasure } from "./measure.js";
import { ModelError, type ChatModel, type ChatResponse, type ReasoningEffort } from "./model.js";
import { parsePersona, personaPrompt, rollWords, sideText, type Side } from "./persona.js";
import { sampleFlags, scenarioPrompt, voiceSystemPrompt, type Scenario } from "./voice.js";

/**
 * The voice test (npm run runner -- voice-test): each bot on its own model and
 * effort writes sample posts in the scenarios of config/voice-probe.yaml,
 * under each side of its persona with a length rolled from the side's range,
 * as a visit would ask, several times over. The same scenarios can run again
 * under the bots' current brief and persona, as a control. The report
 * measures every sample as the voice metrics do and checks each bot against
 * the voice plan's ready line. Nothing touches the board.
 */

export interface TestBot {
  name: string;
  model: string;
  effort: ReasoningEffort;
  /** The persona under test (a draft, or the bot's own). */
  persona: string;
  /** The bot's persona as it is now, for the control. */
  current: string;
}

export interface VoiceTestInput {
  bots: TestBot[];
  scenarios: Scenario[];
  /** Samples per side per scenario. */
  repeat: number;
  memberBrief: string;
  briefSource: string;
  personaSource: string;
  /** The current member brief, to run the control with; null for no control. */
  control: { memberBrief: string; briefSource: string } | null;
  /** Bots whose persona in the database differs from its starting point in personas/, with the database's text. */
  edited?: { name: string; text: string }[];
}

export interface VoiceTestDeps {
  chat: ChatModel;
  now: () => Date;
  random: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

interface Sample {
  bot: string;
  scenario: string;
  /** The side's name; null for a persona without sides, or the control. */
  side: string | null;
  control: boolean;
  asked: number | null;
  effort: ReasoningEffort;
  text: string | null;
  note: string | null;
  flags: string[];
  measure: PostMeasure | null;
}

class DailyCap extends Error {}
const CAPPED = "The test key reached its daily cap.";

export async function runVoiceTest(deps: VoiceTestDeps, input: VoiceTestInput): Promise<string> {
  let capped = false;
  const patterns = loadPatterns();
  const refuses = new Set<string>();
  const samples: Sample[] = [];
  const jobs: (() => Promise<void>)[] = [];

  for (const bot of input.bots) {
    const parts = parsePersona(bot.persona);
    const system = voiceSystemPrompt(input.memberBrief, personaPrompt(bot.persona));
    const sides: (Side | null)[] = parts.sides.length ? parts.sides : [null];
    for (const scenario of input.scenarios) {
      for (const side of sides) {
        for (let i = 0; i < input.repeat; i++) {
          const asked = side ? rollWords(side, deps.random) : null;
          const user = side ? `${sideText(side, asked!)}\n\n${scenarioPrompt(scenario)}` : scenarioPrompt(scenario);
          jobs.push(() => one(bot, scenario, side?.name ?? null, false, asked, system, user));
        }
      }
      if (input.control) {
        const controlSystem = voiceSystemPrompt(input.control.memberBrief, personaPrompt(bot.current));
        for (let i = 0; i < input.repeat; i++) jobs.push(() => one(bot, scenario, null, true, null, controlSystem, scenarioPrompt(scenario)));
      }
    }
  }

  async function one(bot: TestBot, scenario: Scenario, side: string | null, control: boolean, asked: number | null, system: string, user: string) {
    if (capped) return;
    const s: Sample = { bot: bot.name, scenario: scenario.name, side, control, asked, effort: refuses.has(bot.model) ? "default" : bot.effort, text: null, note: null, flags: [], measure: null };
    deps.log(`${bot.name}, ${scenario.name}, ${control ? "control" : (side ?? "no side")}…`);
    const call = () =>
      deps.chat.complete({
        model: bot.model,
        reasoningEffort: s.effort,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });
    let res: ChatResponse;
    try {
      try {
        res = await call();
      } catch (err) {
        if (err instanceof ModelError && err.isDailyCap) throw new DailyCap(CAPPED);
        if (err instanceof ModelError && err.isUnsupportedEffort && s.effort !== "default") {
          refuses.add(bot.model);
          s.effort = "default";
        } else if (!(err instanceof ModelError && err.isTransient)) throw err;
        else await deps.sleep(config.runner.retry_wait_seconds * 1000);
        res = await call();
      }
    } catch (err) {
      if (err instanceof DailyCap || (err instanceof ModelError && err.isDailyCap)) {
        capped = true;
        return;
      }
      s.note = `failed: ${err instanceof ModelError && err.status ? `error ${err.status}${err.code ? ` ${err.code}` : ""}` : err instanceof Error ? err.message.slice(0, 120) : String(err)}`;
      samples.push(s);
      return;
    }
    const text = res.content?.trim() ?? "";
    if (text) {
      // A new thread's answer starts with its board and title; only the post is measured.
      const post = scenario.thread ? text : text.split("\n").slice(2).join("\n").trim() || text;
      s.text = text;
      s.flags = sampleFlags(text, scenario);
      s.measure = measurePost(post, patterns);
    }
    if (res.finishReason === "length") s.note = text ? "cut off at the output limit" : "used the whole output limit without writing anything";
    else if (!text) s.note = res.toolCalls.length ? "tried to call a tool" : "empty reply";
    samples.push(s);
  }

  await inPool(jobs, config.runner.voice_test_parallel_calls);
  if (capped) deps.log(CAPPED);
  return report(input, samples, capped ? CAPPED : null, deps.now());
}

async function inPool(jobs: (() => Promise<void>)[], size: number): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, jobs.length) }, async () => {
      while (next < jobs.length) await jobs[next++]!();
    })
  );
}

const pct = (n: number, of: number) => (of === 0 ? "-" : `${Math.round((n / of) * 100)}%`);
const cell = (s: string) => s.replace(/\|/g, "/").replace(/\n/g, " ");

function fence(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(Math.max(3, longest + 1));
  return `${f}text\n${text}\n${f}`;
}

/** One summary row: a side, all of a bot's sides, or the control. */
function row(bot: string, label: string, these: Sample[], tolerance: number): string {
  const ok = these.filter((s) => s.measure);
  const m = ok.map((s) => s.measure!);
  const asked = ok.filter((s) => s.asked !== null);
  const failed = these.length - ok.length;
  return `| ${cell(bot)} | ${cell(label)} | ${ok.length}${failed ? ` (+${failed} failed)` : ""} | ${asked.length ? median(asked.map((s) => s.asked!)) : "-"} | ${ok.length ? median(m.map((x) => x.words)) : "-"} | ${
    asked.length ? pct(asked.filter((s) => onLength(s.measure!.words, s.asked!, tolerance)).length, asked.length) : "-"
  } | ${pct(m.filter((x) => x.opensWithQuote).length, m.length)} | ${pct(m.filter((x) => x.praise.length).length, m.length)} | ${pct(m.filter((x) => x.phrases.length).length, m.length)} | ${pct(
    m.filter((x) => x.question).length,
    m.length
  )} | ${ok.filter((s) => s.flags.length).length} |`;
}

/** The everyday side: the one with the most weight. */
function everyday(persona: string): Side | null {
  const { sides } = parsePersona(persona);
  return sides.length ? sides.reduce((a, b) => (b.weight > a.weight ? b : a)) : null;
}

function report(input: VoiceTestInput, samples: Sample[], stopped: string | null, at: Date): string {
  const tolerance = config.runner.length_tolerance;
  const lines = [
    `# Voice test, ${at.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    "",
    `- Bots: ${input.bots.map((b) => `${b.name} (${b.model}, effort ${b.effort})`).join(", ")}.`,
    `- Scenarios: ${input.scenarios.map((s) => s.name).join(", ")}. ${input.repeat} sample${input.repeat === 1 ? "" : "s"} per side per scenario.`,
    `- Under test: personas ${input.personaSource}; member brief ${input.briefSource}. Each sample is asked for a length rolled from its side's range, as a visit would ask.`,
    input.control
      ? `- Control: the same scenarios under each bot's current persona and the member brief ${input.control.briefSource}, with no side or length, as visits are now.`
      : "- No control this run.",
    `- Words are each sample's own, quotes left out. "On length" is within ${Math.round(tolerance * 100)}% of the length asked for.`,
  ];
  if (stopped) lines.push(`- **Stopped early:** ${stopped} What's below is what was done before it.`);

  lines.push(
    "",
    "## Summary",
    "",
    "| bot | side | samples | asked (median) | wrote (median) | on length | opens with quote | quote and praise | house phrase | asks a question | flagged |",
    "|---|---|---|---|---|---|---|---|---|---|---|"
  );
  for (const bot of input.bots) {
    const mine = samples.filter((s) => s.bot === bot.name);
    const tested = mine.filter((s) => !s.control);
    const sides = [...new Set(tested.map((s) => s.side))];
    for (const side of sides) lines.push(row(bot.name, side ?? "(no sides)", tested.filter((s) => s.side === side), tolerance));
    if (sides.length > 1) lines.push(row(bot.name, "all sides", tested, tolerance));
    if (input.control) lines.push(row(bot.name, "control (today)", mine.filter((s) => s.control), tolerance));
  }

  lines.push(
    "",
    "## Against the ready line",
    "",
    `Ready means: at least 70% of samples on length; the median inside the everyday side's range; quote and praise in fewer samples than the control. Whether the sides read differently is for reading below.`,
    "",
    "| bot | on length | median vs everyday range | quote and praise vs control | ready |",
    "|---|---|---|---|---|"
  );
  for (const bot of input.bots) {
    const tested = samples.filter((s) => s.bot === bot.name && !s.control && s.measure);
    const control = samples.filter((s) => s.bot === bot.name && s.control && s.measure);
    const asked = tested.filter((s) => s.asked !== null);
    const share = asked.length ? asked.filter((s) => onLength(s.measure!.words, s.asked!, tolerance)).length / asked.length : null;
    const day = everyday(bot.persona);
    const dayWords = day ? tested.filter((s) => s.side === day.name).map((s) => s.measure!.words) : [];
    const med = dayWords.length ? median(dayWords) : null;
    const inRange = day && med !== null ? med >= day.minWords && med <= day.maxWords : null;
    const praise = tested.length ? tested.filter((s) => s.measure!.praise.length).length / tested.length : null;
    const praiseControl = control.length ? control.filter((s) => s.measure!.praise.length).length / control.length : null;
    const fewer = praise !== null && praiseControl !== null ? praise < praiseControl || (praise === 0 && praiseControl === 0) : null;
    const mark = (b: boolean | null) => (b === null ? "?" : b ? "yes" : "no");
    const lengthOk = share === null ? null : share >= 0.7;
    lines.push(
      `| ${cell(bot.name)} | ${share === null ? "-" : `${Math.round(share * 100)}%`} (${mark(lengthOk)}) | ${
        day ? `${med ?? "-"} in ${day.minWords}-${day.maxWords} (${mark(inRange)})` : "no sides"
      } | ${praise === null ? "-" : `${Math.round(praise * 100)}%`} vs ${praiseControl === null ? "-" : `${Math.round(praiseControl * 100)}%`} (${mark(fewer)}) | ${
        lengthOk && inRange && fewer !== false ? "yes" : lengthOk === null || inRange === null ? "?" : "no"
      } |`
    );
  }

  for (const bot of input.bots) {
    const mine = samples.filter((s) => s.bot === bot.name);
    if (!mine.length) continue;
    lines.push("", `## ${bot.name}`);
    for (const scenario of input.scenarios) {
      const these = mine.filter((s) => s.scenario === scenario.name);
      if (!these.length) continue;
      lines.push("", `### ${bot.name}: ${scenario.name}`);
      const groups = [...new Set(these.filter((s) => !s.control).map((s) => s.side))];
      for (const side of groups) {
        for (const s of these.filter((x) => !x.control && x.side === side)) lines.push(...sampleLines(s, side ?? "no sides"));
      }
      for (const s of these.filter((x) => x.control)) lines.push(...sampleLines(s, "control (today)"));
    }
  }
  if (input.edited?.length) {
    lines.push("", "## Personas edited since personas/", "", "These bots' personas in the database differ from their files in personas/, so a draft written from the file may have dropped an edit. Their current text:");
    for (const e of input.edited) lines.push("", `### ${e.name}`, "", fence(e.text));
  }
  return `${lines.join("\n")}\n`;
}

function sampleLines(s: Sample, label: string): string[] {
  const facts = [
    ...(s.asked !== null ? [`asked ${s.asked}`] : []),
    ...(s.measure ? [`wrote ${s.measure.words}`] : []),
    ...(s.measure?.opensWithQuote ? ["opens with a quote"] : []),
    ...(s.measure?.praise.length ? [`quote and praise: ${s.measure.praise.join(", ")}`] : []),
    ...(s.measure?.phrases.length ? [`house phrases: ${s.measure.phrases.join(", ")}`] : []),
    ...(s.flags.length ? [`flags: ${s.flags.join("; ")}`] : []),
    ...(s.note ? [s.note] : []),
    `effort ${s.effort}`,
  ];
  return ["", `#### ${label} · ${facts.join(" · ")}`, ...(s.text ? ["", fence(s.text)] : [])];
}
