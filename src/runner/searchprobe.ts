import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { config } from "../config.js";
import { ModelError, type ChatModel, type ChatResponse } from "./model.js";
import {
  RECENCIES,
  research,
  researchBrief,
  RESEARCHER,
  SearchError,
  summaryProblems,
  type Researcher,
  type SearchBackend,
  type SearchHit,
  type SearchService,
} from "./websearch.js";

/**
 * The search probe: which search service, and which research model, the bots
 * should use. Every query in config/search-probe.yaml goes to every service
 * with a key, and each research model writes a summary from each one's
 * results, as a bot would get it. The report puts the services and the
 * models side by side, query by query. Nothing touches the board.
 */

const KINDS = ["current", "recent", "other"] as const;

const QuerySchema = z.object({
  name: z.string().regex(/^[a-z0-9_-]+$/),
  kind: z.enum(KINDS),
  query: z.string().min(1),
  recency: z.enum(RECENCIES).optional(),
  check: z.string().min(1).optional(),
});
const QueriesSchema = z.object({ queries: z.array(QuerySchema).min(1) });

export type ProbeQuery = z.infer<typeof QuerySchema>;

export const QUERIES_FILE = path.join(import.meta.dirname, "..", "..", "config", "search-probe.yaml");

export function loadQueries(file = QUERIES_FILE): ProbeQuery[] {
  const queries = QueriesSchema.parse(YAML.parse(readFileSync(file, "utf-8"))).queries;
  const seen = new Set<string>();
  for (const q of queries) {
    if (seen.has(q.name)) throw new Error(`${file}: two queries are named ${q.name}.`);
    seen.add(q.name);
  }
  return queries;
}

export interface SearchProbeDeps {
  backends: SearchBackend[];
  /** The research models' key (the probe key). */
  chat: ChatModel;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** Progress, one line at a time. */
  log: (line: string) => void;
}

export interface SearchProbeInput {
  queries: ProbeQuery[];
  /** Services left out for want of a key, for the report. */
  skipped: SearchService[];
  /** The research models to compare; without them, the configured one. */
  researchers?: Researcher[];
}

export interface ProbeSummary {
  /** Which of the research models asked for, by position. */
  slot: number;
  /** The model, and the effort it actually ran at. */
  researcher: Researcher;
  text: string | null;
  /** Why there's no text, or that it was cut off. */
  note: string | null;
  /** From summaryProblems. */
  problems: string[];
  seconds: number;
}

export interface ProbeSearch {
  query: string;
  service: SearchService;
  hits: SearchHit[];
  costDollars: number | null;
  seconds: number;
  /** Why the search failed. */
  error: string | null;
  /** One per research model, when there were results to summarize. */
  summaries: ProbeSummary[];
}

class DailyCap extends Error {}
const CAPPED = "The probe key reached its daily cap.";

/**
 * Runs each query through every service, side by side, then has each
 * research model summarize each result set. Returns the report. When the
 * probe key reaches its daily cap, the run stops and the report says so.
 */
export async function runSearchProbe(deps: SearchProbeDeps, input: SearchProbeInput): Promise<string> {
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
  const researchers = input.researchers?.length ? input.researchers : [RESEARCHER];
  // Models found to refuse reasoning_effort run at default from then on.
  const refuses = new Set<string>();

  const done: ProbeSearch[] = [];
  let stopped: string | null = null;
  for (const q of input.queries) {
    deps.log(`${q.name}: "${q.query}"…`);
    const now = deps.now();
    const searches = await Promise.all(deps.backends.map((b) => search(deps, b, q, now)));
    const jobs = searches.flatMap((s) =>
      s.hits.length ? researchers.map((r, slot) => async () => void s.summaries.push(await summarize(deps, chat, refuses, r, slot, q, s.hits, now))) : []
    );
    await inPool(jobs, config.runner.search_probe_parallel_calls);
    // Summaries finish in any order; the report lists them as asked.
    for (const s of searches) s.summaries.sort((a, b) => a.slot - b.slot);
    done.push(...searches);
    if (capped) {
      stopped = CAPPED;
      deps.log(CAPPED);
      break;
    }
  }
  return report(deps, input, researchers, done, stopped);
}

async function search(deps: SearchProbeDeps, backend: SearchBackend, q: ProbeQuery, now: Date): Promise<ProbeSearch> {
  const out: ProbeSearch = { query: q.name, service: backend.service, hits: [], costDollars: null, seconds: 0, error: null, summaries: [] };
  const started = deps.now().getTime();
  try {
    const call = () => backend.search(q.query, { recency: q.recency ?? null, now });
    let result;
    try {
      result = await call();
    } catch (err) {
      if (!(err instanceof SearchError && err.isTransient)) throw err;
      await deps.sleep(config.runner.retry_wait_seconds * 1000);
      result = await call();
    }
    out.hits = result.hits;
    out.costDollars = result.costDollars;
  } catch (err) {
    out.error = err instanceof Error ? err.message.slice(0, 300) : String(err);
  }
  out.seconds = (deps.now().getTime() - started) / 1000;
  return out;
}

async function summarize(
  deps: SearchProbeDeps,
  chat: ChatModel,
  refuses: Set<string>,
  wanted: Researcher,
  slot: number,
  q: ProbeQuery,
  hits: SearchHit[],
  now: Date
): Promise<ProbeSummary> {
  const researcher = { ...wanted, effort: refuses.has(wanted.model) ? ("default" as const) : wanted.effort };
  const out: ProbeSummary = { slot, researcher, text: null, note: null, problems: [], seconds: 0 };
  const started = deps.now().getTime();
  let res: ChatResponse;
  try {
    const call = () => research(chat, q.query, q.recency ?? null, hits, now, researcher);
    try {
      res = await call();
    } catch (err) {
      if (err instanceof ModelError && err.isUnsupportedEffort && researcher.effort !== "default") {
        refuses.add(researcher.model);
        researcher.effort = "default";
      } else if (!(err instanceof ModelError && err.isTransient)) {
        throw err;
      } else {
        await deps.sleep(config.runner.retry_wait_seconds * 1000);
      }
      res = await call();
    }
  } catch (err) {
    out.seconds = (deps.now().getTime() - started) / 1000;
    out.note =
      err instanceof DailyCap
        ? "not written: the probe key reached its daily cap"
        : `failed: ${err instanceof ModelError && err.status ? `error ${err.status}${err.code ? ` ${err.code}` : ""}` : err instanceof Error ? err.message.slice(0, 120) : String(err)}`;
    return out;
  }
  out.seconds = (deps.now().getTime() - started) / 1000;
  const text = res.content?.trim() ?? "";
  if (text) {
    out.text = text;
    out.problems = summaryProblems(text);
  }
  if (res.finishReason === "length") out.note = text ? "cut off at the output limit" : "used the whole output limit without writing anything";
  else if (!text) out.note = "empty reply";
  return out;
}

/** Runs the jobs, at most `size` at a time. */
async function inPool(jobs: (() => Promise<void>)[], size: number): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, jobs.length) }, async () => {
      while (next < jobs.length) await jobs[next++]!();
    })
  );
}

/** The newest dated hit, or null. */
const newest = (hits: SearchHit[]) =>
  hits
    .map((h) => h.published)
    .filter((d): d is string => d !== null)
    .sort()
    .at(-1) ?? null;

const kindName: Record<ProbeQuery["kind"], string> = { current: "current events", recent: "recent history", other: "other" };

function report(deps: SearchProbeDeps, input: SearchProbeInput, researchers: Researcher[], done: ProbeSearch[], stopped: string | null): string {
  const at = deps.now();
  const services = deps.backends.map((b) => b.service);
  const counts = KINDS.map((k) => `${input.queries.filter((q) => q.kind === k).length} ${kindName[k]}`).join(", ");
  const r = config.runner;
  const many = researchers.length > 1;
  const lines: string[] = [
    `# Search probe, ${at.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    "",
    `- Services: ${services.join(", ")}.${input.skipped.length ? ` Skipped, with no key: ${input.skipped.join(", ")}.` : ""}`,
    `- Queries: ${input.queries.length} (${counts}), from config/search-probe.yaml.`,
    `- Each search asks for ${r.web_search_results} results, each cut to ${r.web_search_page_chars.toLocaleString("en-US")} characters.`,
    `- Research model${many ? "s" : ""}: ${researchers.map(name).join("; ")}. ${many ? "Each writes" : "It writes"} a summary of at most ${r.web_search_summary_chars.toLocaleString("en-US")} characters from every result set, with the same instructions every time; they're at the end of this report.`,
  ];
  if (stopped) lines.push(`- **Stopped early:** ${stopped} What's below is what was done before it.`);

  lines.push("", "## By service", "", ...serviceTable(services, done));
  lines.push(
    "",
    "## By research model",
    "",
    "Problems are checked mechanically: longer than asked, thinking aloud, not ending cleanly, a run-on sentence. A problem is a reason to read the summary, and in production a reason not to hand it to a bot.",
    "",
    ...researcherTable(researchers, done)
  );
  lines.push(
    "",
    "## By query",
    "",
    "Results, how many are dated, the newest date, and seconds for the search.",
    "",
    ...queryTable(input.queries, services, done)
  );

  for (const q of input.queries) {
    const these = done.filter((s) => s.query === q.name);
    if (!these.length) continue;
    lines.push("", `## ${q.name}: "${q.query}"`, "", `*${kindName[q.kind]}${q.recency ? `, results from the last ${q.recency}` : ", any age"}.*`);
    if (q.check) lines.push("", `Check: ${q.check}`);
    for (const s of these) {
      const facts = [
        s.error ? "failed" : `${s.hits.length} results`,
        `${s.seconds.toFixed(1)}s`,
        ...(s.costDollars !== null ? [`$${s.costDollars.toFixed(4)}`] : []),
      ];
      lines.push("", `### ${q.name}: ${s.service}`, "", `*${facts.join(", ")}*${s.error ? `. **${s.error}**` : ""}`);
      if (s.hits.length) {
        lines.push("");
        s.hits.forEach((h, i) => {
          lines.push(`${i + 1}. **${oneLine(h.title)}**, ${h.site || "unknown site"}, ${h.published ?? "undated"}  `, `   ${oneLine(clip(h.text, 300))}`);
        });
      } else lines.push("", `No summary: ${s.error ? "no search" : "no results"}.`);
      for (const sum of s.summaries) {
        const facts = [`${sum.seconds.toFixed(1)}s`, ...(sum.text ? [`${sum.text.length} characters`] : [])];
        const notes = [...(sum.note ? [sum.note] : []), ...sum.problems];
        lines.push("", `#### ${q.name}: ${s.service}, ${name(sum.researcher)}`, "", `*${facts.join(", ")}*${notes.length ? `. **${notes.join("; ")}**` : ""}`);
        if (sum.text) lines.push("", fence(sum.text));
      }
    }
  }

  lines.push("", "## The research model's instructions", "", fence(researchBrief(at.toISOString().slice(0, 10))));
  return `${lines.join("\n")}\n`;
}

const name = (r: Researcher) => `${r.model}, effort ${r.effort}`;

function median(xs: number[]): number | null {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null;
}

function serviceTable(services: SearchService[], done: ProbeSearch[]): string[] {
  const rows = [
    "| service | searches | failed | no results | results | dated | median search | cost reported |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const service of services) {
    const mine = done.filter((s) => s.service === service);
    const ok = mine.filter((s) => !s.error);
    const hits = ok.flatMap((s) => s.hits);
    const dated = hits.filter((h) => h.published !== null).length;
    const m = median(ok.map((s) => s.seconds));
    const costs = mine.map((s) => s.costDollars).filter((c): c is number => c !== null);
    const cost = costs.length ? `$${costs.reduce((a, b) => a + b, 0).toFixed(4)}` : "–";
    rows.push(
      `| ${service} | ${mine.length} | ${mine.length - ok.length} | ${ok.filter((s) => !s.hits.length).length} | ${hits.length} | ${hits.length ? `${Math.round((dated / hits.length) * 100)}%` : "–"} | ${m === null ? "–" : `${m.toFixed(1)}s`} | ${cost} |`
    );
  }
  return rows;
}

/** A row per research model (as asked; a refused effort shows in the summaries). */
function researcherTable(researchers: Researcher[], done: ProbeSearch[]): string[] {
  const rows = [
    "| model | effort | asked | written | no text | with problems | thinking aloud | not ending cleanly | longer than asked | run-on | median length | median time |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  const all = done.flatMap((s) => s.summaries);
  for (const [slot, r] of researchers.entries()) {
    const mine = all.filter((x) => x.slot === slot);
    const written = mine.filter((x) => x.text !== null);
    const count = (re: RegExp) => written.filter((x) => x.problems.some((p) => re.test(p))).length;
    const len = median(written.map((x) => x.text!.length));
    const secs = median(mine.map((x) => x.seconds));
    rows.push(
      `| ${r.model} | ${r.effort} | ${mine.length} | ${written.length} | ${mine.length - written.length} | ${written.filter((x) => x.problems.length || x.note).length} | ${count(/^thinking aloud/)} | ${count(/^doesn't end cleanly/)} | ${count(/^longer than asked/)} | ${count(/-character sentence$/)} | ${len === null ? "–" : len.toLocaleString("en-US")} | ${secs === null ? "–" : `${secs.toFixed(1)}s`} |`
    );
  }
  return rows;
}

function queryTable(queries: ProbeQuery[], services: SearchService[], done: ProbeSearch[]): string[] {
  const cell = (s: ProbeSearch | undefined) => {
    if (!s) return "";
    if (s.error) return "search failed";
    const dated = s.hits.filter((h) => h.published !== null).length;
    const parts = [`${s.hits.length} results`, ...(s.hits.length ? [`${dated} dated`] : []), ...(newest(s.hits) ? [`newest ${newest(s.hits)}`] : []), `${s.seconds.toFixed(1)}s`];
    return parts.join(", ").replace(/\|/g, "/");
  };
  const rows = [`| query | kind | ${services.join(" | ")} |`, `|---|---|${services.map(() => "---").join("|")}|`];
  for (const q of queries) {
    const these = done.filter((s) => s.query === q.name);
    if (!these.length) continue;
    rows.push(`| ${q.name} | ${q.kind} | ${services.map((sv) => cell(these.find((s) => s.service === sv))).join(" | ")} |`);
  }
  return rows;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A fenced block that the text can't close early. */
function fence(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(Math.max(3, longest + 1));
  return `${f}text\n${text}\n${f}`;
}
