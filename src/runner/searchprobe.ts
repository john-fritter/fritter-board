import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { config } from "../config.js";
import { ModelError, type ChatModel, type ChatResponse } from "./model.js";
import { RECENCIES, research, researchBrief, SearchError, type SearchBackend, type SearchHit, type SearchService } from "./websearch.js";

/**
 * The search probe: which search service the bots should use. Every query in
 * config/search-probe.yaml goes to every service with a key, and the research
 * model writes a summary from each one's results, as a bot would get it. The
 * report puts the services side by side, query by query. Nothing touches the
 * board.
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
  /** The research model's key (the probe key). */
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
}

export interface ProbeSearch {
  query: string;
  service: SearchService;
  hits: SearchHit[];
  costDollars: number | null;
  seconds: number;
  /** Why the search failed. */
  error: string | null;
  summary: string | null;
  /** Why there's no summary, or what was odd about it. */
  summaryNote: string | null;
  summarySeconds: number;
}

class DailyCap extends Error {}
const CAPPED = "The probe key reached its daily cap.";

/**
 * Runs each query through every service, side by side, then has the
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

  const done: ProbeSearch[] = [];
  let stopped: string | null = null;
  for (const q of input.queries) {
    deps.log(`${q.name}: "${q.query}"…`);
    // The services run side by side: at most one research call each at a time.
    done.push(...(await Promise.all(deps.backends.map((b) => one(deps, chat, b, q)))));
    if (capped) {
      stopped = CAPPED;
      deps.log(CAPPED);
      break;
    }
  }
  return report(deps, input, done, stopped);
}

async function one(deps: SearchProbeDeps, chat: ChatModel, backend: SearchBackend, q: ProbeQuery): Promise<ProbeSearch> {
  const out: ProbeSearch = {
    query: q.name,
    service: backend.service,
    hits: [],
    costDollars: null,
    seconds: 0,
    error: null,
    summary: null,
    summaryNote: null,
    summarySeconds: 0,
  };
  const recency = q.recency ?? null;
  const now = deps.now();
  const started = now.getTime();
  try {
    const search = () => backend.search(q.query, { recency, now });
    let result;
    try {
      result = await search();
    } catch (err) {
      if (!(err instanceof SearchError && err.isTransient)) throw err;
      await deps.sleep(config.runner.retry_wait_seconds * 1000);
      result = await search();
    }
    out.hits = result.hits;
    out.costDollars = result.costDollars;
  } catch (err) {
    out.error = err instanceof Error ? err.message.slice(0, 300) : String(err);
  }
  out.seconds = (deps.now().getTime() - started) / 1000;
  if (out.error) {
    out.summaryNote = "no search, so no summary";
    return out;
  }
  if (!out.hits.length) {
    out.summaryNote = "no results, so no summary";
    return out;
  }

  const summaryStarted = deps.now().getTime();
  let res: ChatResponse;
  try {
    const call = () => research(chat, q.query, recency, out.hits, now);
    try {
      res = await call();
    } catch (err) {
      if (!(err instanceof ModelError && err.isTransient)) throw err;
      await deps.sleep(config.runner.retry_wait_seconds * 1000);
      res = await call();
    }
  } catch (err) {
    out.summarySeconds = (deps.now().getTime() - summaryStarted) / 1000;
    if (err instanceof DailyCap) {
      out.summaryNote = "not written: the probe key reached its daily cap";
      return out;
    }
    out.summaryNote = `failed: ${err instanceof ModelError && err.status ? `error ${err.status}${err.code ? ` ${err.code}` : ""}` : err instanceof Error ? err.message.slice(0, 120) : String(err)}`;
    return out;
  }
  out.summarySeconds = (deps.now().getTime() - summaryStarted) / 1000;
  const text = res.content?.trim() ?? "";
  if (text) out.summary = text;
  if (res.finishReason === "length") out.summaryNote = text ? "cut off at the output limit" : "used the whole output limit without writing anything";
  else if (!text) out.summaryNote = "empty reply";
  else if (text.length > config.runner.web_search_summary_chars * 1.2) out.summaryNote = `longer than asked (${text.length} characters)`;
  return out;
}

/** The newest dated hit, or null. */
const newest = (hits: SearchHit[]) =>
  hits
    .map((h) => h.published)
    .filter((d): d is string => d !== null)
    .sort()
    .at(-1) ?? null;

const kindName: Record<ProbeQuery["kind"], string> = { current: "current events", recent: "recent history", other: "other" };

function report(deps: SearchProbeDeps, input: SearchProbeInput, done: ProbeSearch[], stopped: string | null): string {
  const at = deps.now();
  const services = deps.backends.map((b) => b.service);
  const counts = KINDS.map((k) => `${input.queries.filter((q) => q.kind === k).length} ${kindName[k]}`).join(", ");
  const r = config.runner;
  const lines: string[] = [
    `# Search probe, ${at.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    "",
    `- Services: ${services.join(", ")}.${input.skipped.length ? ` Skipped, with no key: ${input.skipped.join(", ")}.` : ""}`,
    `- Queries: ${input.queries.length} (${counts}), from config/search-probe.yaml.`,
    `- Each search asks for ${r.web_search_results} results, each cut to ${r.web_search_page_chars.toLocaleString("en-US")} characters. The research model (${r.web_search_model}, effort ${r.web_search_reasoning_effort}) writes a summary of at most ${r.web_search_summary_chars.toLocaleString("en-US")} characters from them, with the same instructions for every service; they're at the end of this report.`,
  ];
  if (stopped) lines.push(`- **Stopped early:** ${stopped} What's below is what was done before it.`);

  lines.push("", "## By service", "", ...serviceTable(services, done));
  lines.push(
    "",
    "## By query",
    "",
    "Results, how many are dated, the newest date, and seconds for the search. A failed search or summary says so.",
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
      }
      const note = s.summaryNote ? `. **${s.summaryNote}**` : "";
      if (s.summary) lines.push("", `Summary (${s.summarySeconds.toFixed(1)}s, ${s.summary.length} characters)${note}:`, "", fence(s.summary));
      else lines.push("", `No summary${note}.`);
    }
  }

  lines.push("", "## The research model's instructions", "", fence(researchBrief(at.toISOString().slice(0, 10))));
  return `${lines.join("\n")}\n`;
}

function serviceTable(services: SearchService[], done: ProbeSearch[]): string[] {
  const rows = [
    "| service | searches | failed | no results | results | dated | median search | summaries | cost reported |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const service of services) {
    const mine = done.filter((s) => s.service === service);
    const ok = mine.filter((s) => !s.error);
    const hits = ok.flatMap((s) => s.hits);
    const dated = hits.filter((h) => h.published !== null).length;
    const seconds = ok.map((s) => s.seconds).sort((a, b) => a - b);
    const median = seconds.length ? `${seconds[Math.floor(seconds.length / 2)]!.toFixed(1)}s` : "–";
    const costs = mine.map((s) => s.costDollars).filter((c): c is number => c !== null);
    const cost = costs.length ? `$${costs.reduce((a, b) => a + b, 0).toFixed(4)}` : "–";
    const summaries = mine.filter((s) => s.summary).length;
    rows.push(
      `| ${service} | ${mine.length} | ${mine.length - ok.length} | ${ok.filter((s) => !s.hits.length).length} | ${hits.length} | ${hits.length ? `${Math.round((dated / hits.length) * 100)}%` : "–"} | ${median} | ${summaries} | ${cost} |`
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
    if (s.hits.length && !s.summary) parts.push(`summary: ${s.summaryNote ?? "none"}`);
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
