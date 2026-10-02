import { config } from "../config.js";
import { ModelError, nextUtcMidnight, type ChatModel, type ChatResponse, type ReasoningEffort } from "./model.js";

/**
 * Web search for the bots: a search service finds pages, and the research
 * model, one cheap model with no persona, turns them into a short factual
 * summary. Only the summary reaches a bot, so web pages never enter its
 * context and it never sees a URL to post.
 *
 * Three services are wired up, all with free tiers: LangSearch, Exa and
 * Linkup. The search probe (./searchprobe.ts) compares them; the bots' tool
 * will use the one chosen. Each takes an injectable fetch, so tests run
 * without a network.
 */

export const SEARCH_SERVICES = ["langsearch", "exa", "linkup"] as const;
export type SearchService = (typeof SEARCH_SERVICES)[number];

/** How recent results must be; none means any age. */
export const RECENCIES = ["day", "week", "month", "year"] as const;
export type Recency = (typeof RECENCIES)[number];

const RECENCY_DAYS: Record<Recency, number> = { day: 1, week: 7, month: 31, year: 366 };

export interface SearchHit {
  title: string;
  url: string;
  /** The site's host name without www, which the summary names sources by. */
  site: string;
  /** YYYY-MM-DD, when the service gives a publication date. */
  published: string | null;
  /** Set when the service's dates are often when the page was crawled, not published (LangSearch). */
  crawled?: true;
  text: string;
}

export interface SearchResult {
  hits: SearchHit[];
  /** What the service says the search cost, when it says. */
  costDollars: number | null;
}

export interface SearchOptions {
  recency: Recency | null;
  now: Date;
}

export interface SearchBackend {
  readonly service: SearchService;
  search(query: string, opts: SearchOptions): Promise<SearchResult>;
}

/** A search that failed. `status` is the HTTP status, or null for a timeout or network error. */
export class SearchError extends Error {
  constructor(
    message: string,
    readonly status: number | null
  ) {
    super(message);
    this.name = "SearchError";
  }

  /** Worth one retry: rate limiting, server errors, timeouts, network. */
  get isTransient(): boolean {
    return this.status === null || this.status === 429 || this.status >= 500;
  }
}

type Fetch = typeof fetch;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Whitespace collapsed, cut at a word boundary to web_search_page_chars. */
export function pageText(s: string, max = config.runner.web_search_page_chars): string {
  const text = s.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > max * 0.8 ? cut.slice(0, space) : cut}…`;
}

function site(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** A date as YYYY-MM-DD, or null when there isn't one that parses. */
function day(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** The start of a recency window, as a Date. */
function since(now: Date, recency: Recency): Date {
  return new Date(now.getTime() - RECENCY_DAYS[recency] * 86_400_000);
}

function hit(title: unknown, url: unknown, published: unknown, text: string): SearchHit | null {
  const u = str(url);
  const t = pageText(text);
  if (!u || !t) return null;
  return { title: pageText(str(title), 200) || site(u), url: u, site: site(u), published: day(published), text: t };
}

async function postJson(service: SearchService, url: string, headers: Record<string, string>, body: unknown, fetchImpl: Fetch | undefined): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await (fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.runner.web_search_timeout_seconds * 1000),
    });
  } catch (err) {
    const what = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "couldn't be reached";
    throw new SearchError(`${service} ${what}: ${err instanceof Error ? err.message : String(err)}`, null);
  }
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const e = json?.["error"];
    const message =
      (typeof e === "string" && e) ||
      str((e as Record<string, unknown> | undefined)?.["message"]) ||
      str(json?.["message"]) ||
      str(json?.["msg"]) ||
      text.slice(0, 300) ||
      res.statusText;
    throw new SearchError(`${service} ${res.status}: ${message}`, res.status);
  }
  if (!json) throw new SearchError(`${service} sent something that isn't JSON.`, res.status);
  return json;
}

const LANGSEARCH_FRESHNESS: Record<Recency, string> = { day: "oneDay", week: "oneWeek", month: "oneMonth", year: "oneYear" };

/** LangSearch: free, with a daily allowance. Full page text, cut to our length. */
export class LangSearch implements SearchBackend {
  readonly service = "langsearch";
  constructor(
    private readonly apiKey: string,
    private readonly opts: { fetch?: Fetch } = {}
  ) {}

  async search(query: string, opts: SearchOptions): Promise<SearchResult> {
    const body: Record<string, unknown> = {
      query,
      count: config.runner.web_search_results,
      contents: { text: { max_characters: config.runner.web_search_page_chars } },
    };
    if (opts.recency) body["freshness"] = LANGSEARCH_FRESHNESS[opts.recency];
    const json = await postJson(this.service, "https://api.langsearch.com/v1/web-search", { Authorization: `Bearer ${this.apiKey}` }, body, this.opts.fetch);
    // Errors can also come back as HTTP 200 with a code of their own.
    if (json["code"] !== undefined && String(json["code"]) !== "200") {
      const code = Number(json["code"]);
      throw new SearchError(`langsearch ${String(json["code"])}: ${str(json["msg"]) || str(json["message"]) || "error"}`, Number.isFinite(code) ? code : null);
    }
    const pages = ((json["data"] as Record<string, unknown> | undefined)?.["webPages"] as Record<string, unknown> | undefined)?.["value"];
    const hits = (Array.isArray(pages) ? (pages as Record<string, unknown>[]) : [])
      .map((p) => hit(p["name"], p["url"], p["datePublished"], str(p["text"]) || str(p["summary"]) || str(p["snippet"])))
      .filter((h): h is SearchHit => h !== null)
      // Its "datePublished" is often the crawl date: a 2025 story came back
      // dated August 2026. The research model is told so.
      .map((h) => (h.published ? { ...h, crawled: true as const } : h));
    return { hits, costDollars: null };
  }
}

/** Exa: a free monthly credit. Query-relevant passages ("highlights") of each page. */
export class Exa implements SearchBackend {
  readonly service = "exa";
  constructor(
    private readonly apiKey: string,
    private readonly opts: { fetch?: Fetch } = {}
  ) {}

  async search(query: string, opts: SearchOptions): Promise<SearchResult> {
    const body: Record<string, unknown> = {
      query,
      type: "auto",
      numResults: config.runner.web_search_results,
      contents: { highlights: { maxCharacters: config.runner.web_search_page_chars } },
    };
    if (opts.recency) body["startPublishedDate"] = since(opts.now, opts.recency).toISOString();
    const json = await postJson(this.service, "https://api.exa.ai/search", { "x-api-key": this.apiKey }, body, this.opts.fetch);
    const results = Array.isArray(json["results"]) ? (json["results"] as Record<string, unknown>[]) : [];
    const hits = results
      .map((r) => {
        const highlights = Array.isArray(r["highlights"]) ? (r["highlights"] as unknown[]).map(str).filter(Boolean).join(" … ") : "";
        return hit(r["title"], r["url"], r["publishedDate"], highlights || str(r["text"]) || str(r["summary"]));
      })
      .filter((h): h is SearchHit => h !== null);
    const cost = (json["costDollars"] as Record<string, unknown> | undefined)?.["total"];
    return { hits, costDollars: typeof cost === "number" ? cost : null };
  }
}

/** Linkup: a free monthly credit. Standard depth; its results carry no dates. */
export class Linkup implements SearchBackend {
  readonly service = "linkup";
  constructor(
    private readonly apiKey: string,
    private readonly opts: { fetch?: Fetch } = {}
  ) {}

  async search(query: string, opts: SearchOptions): Promise<SearchResult> {
    const body: Record<string, unknown> = {
      q: query,
      depth: "standard",
      outputType: "searchResults",
      maxResults: config.runner.web_search_results,
      includeImages: false,
    };
    if (opts.recency) body["fromDate"] = since(opts.now, opts.recency).toISOString().slice(0, 10);
    const json = await postJson(this.service, "https://api.linkup.so/v1/search", { Authorization: `Bearer ${this.apiKey}` }, body, this.opts.fetch);
    const results = Array.isArray(json["results"]) ? (json["results"] as Record<string, unknown>[]) : [];
    const hits = results
      .filter((r) => r["type"] === undefined || r["type"] === "text")
      .map((r) => hit(r["name"], r["url"], r["date"] ?? r["publishedDate"], str(r["content"])))
      .filter((h): h is SearchHit => h !== null)
      .slice(0, config.runner.web_search_results);
    return { hits, costDollars: null };
  }
}

export function searchBackend(service: SearchService, apiKey: string, opts: { fetch?: Fetch } = {}): SearchBackend {
  if (service === "langsearch") return new LangSearch(apiKey, opts);
  if (service === "exa") return new Exa(apiKey, opts);
  return new Linkup(apiKey, opts);
}

/** The research model's instructions. Today's date matters: it judges how current the results are. */
export function researchBrief(today: string): string {
  return `You are a research assistant for the members of a discussion forum. A member searched the web; you're given the results, and you write the member a short, factual briefing from them.

- Use only what the results say. Don't fill gaps from your own knowledge: the results may be newer than anything you know, and where they disagree with what you remember, the results win.
- Lead with the direct answer to the search, if the results give one. Then the facts that matter: names, dates, numbers, places, and what happened in what order.
- Say where each fact comes from, by the publication or site's name and the date when there is one, like (Reuters, 2026-09-14). Never give URLs.
- Say how current the results are. If the newest is weeks or months old, or undated, say so, above all when the search is about something recent.
- When sources disagree, say who says what. When the results don't answer the search, or are about something else, say that plainly instead of guessing.
- No opinions, advice or commentary, and no introduction or sign-off.

Today is ${today}. Write plain text, not Markdown, in at most ${config.runner.web_search_summary_chars} characters.`;
}

/** The research model's input: the search, then each result with its site and date. */
export function researchPrompt(query: string, recency: Recency | null, hits: SearchHit[]): string {
  const date = (h: SearchHit) =>
    !h.published ? "Published: no date given." : h.crawled ? `Dated ${h.published}, which may be when the page was seen rather than published.` : `Published: ${h.published}.`;
  const results = hits.map((h, i) => `[${i + 1}] ${h.title}\nSite: ${h.site || "unknown"}. ${date(h)}\n${h.text}`);
  return `The search: "${query}"${recency ? ` (results from the last ${recency})` : ""}\n\nThe results:\n\n${results.join("\n\n")}`;
}

/** A research model and the effort it runs at. */
export interface Researcher {
  model: string;
  effort: ReasoningEffort;
}

/** The research models, in the order they're tried. */
export const RESEARCHERS: Researcher[] = config.runner.web_search_models;
export const RESEARCHER: Researcher = RESEARCHERS[0]!;

/** One call to the research model. The caller handles retries and the key's daily cap. */
export function research(
  chat: ChatModel,
  query: string,
  recency: Recency | null,
  hits: SearchHit[],
  now: Date,
  researcher: Researcher = RESEARCHER
): Promise<ChatResponse> {
  return chat.complete({
    model: researcher.model,
    reasoningEffort: researcher.effort,
    messages: [
      { role: "system", content: researchBrief(now.toISOString().slice(0, 10)) },
      { role: "user", content: researchPrompt(query, recency, hits) },
    ],
  });
}

/**
 * What's wrong with a summary, checked mechanically. The first search probe
 * found the research model sometimes thinking aloud into its answer ("wait,
 * careful… let me"), trailing off, or ending in word salad: one sentence
 * running on for well over a thousand characters. All five broken summaries
 * tripped at least one of these; of the 48 sound ones, only the overlong
 * did. A bot should never get a summary with problems.
 */
export function summaryProblems(text: string): string[] {
  const problems: string[] = [];
  const t = text.trim();
  if (t.length > config.runner.web_search_summary_chars * 1.2) problems.push(`longer than asked (${t.length} characters)`);
  if (/\b(?:wait|hmm+|hold on|actually)[,.!:;—–]|\b(?:let me|let's|I need to|I should|I'll)\b/i.test(t)) problems.push("thinking aloud");
  if (!/[.!?)"'”’\]]$/.test(t) || /(?:\.\.\.|…)$/.test(t)) problems.push("doesn't end cleanly");
  const longest = Math.max(0, ...t.split(/(?<=[.!?])\s+/).map((x) => x.length));
  if (longest > 1200) problems.push(`a ${longest.toLocaleString("en-US")}-character sentence`);
  return problems;
}

// ── The bots' web search ───────────────────────────────────────────────────

export type SearchOutcome = "ok" | "no_results" | "search_failed" | "summary_failed" | "research_capped";

/** One search, as it went: what the bot gets, and what the run log keeps. */
export interface WebSearchRecord {
  query: string;
  recency: Recency | null;
  outcome: SearchOutcome;
  /** The service whose results were used. */
  service: SearchService | null;
  hits: SearchHit[];
  researchModel: string | null;
  summary: string | null;
  /** What went wrong along the way, fallbacks included. */
  errors: string[];
  researchCalls: number;
}

/**
 * The bots' web search: the services in order until one finds something,
 * then the research models in order until one writes a summary with no
 * problems. Anything going wrong ends in a record that says so, never an
 * exception: a search is a convenience, never a reason for a visit to fail.
 * When the research key hits its daily cap, searches stop until it resets.
 */
export class WebSearch {
  private pausedUntil = 0;

  constructor(
    readonly backends: SearchBackend[],
    private readonly chat: ChatModel,
    private readonly deps: { now(): Date },
    readonly researchers: Researcher[] = RESEARCHERS
  ) {}

  /** Whether the research key is usable now. */
  get ready(): boolean {
    return this.deps.now().getTime() >= this.pausedUntil;
  }

  async search(query: string, recency: Recency | null): Promise<WebSearchRecord> {
    const out: WebSearchRecord = { query, recency, outcome: "search_failed", service: null, hits: [], researchModel: null, summary: null, errors: [], researchCalls: 0 };
    const now = this.deps.now();
    if (!this.ready) {
      out.outcome = "research_capped";
      return out;
    }
    let answered = false;
    for (const backend of this.backends) {
      try {
        const result = await backend.search(query, { recency, now });
        answered = true;
        if (result.hits.length) {
          out.service = backend.service;
          out.hits = result.hits;
          break;
        }
        out.errors.push(`${backend.service}: no results`);
      } catch (err) {
        out.errors.push(err instanceof Error ? err.message.slice(0, 200) : String(err));
      }
    }
    if (!out.hits.length) {
      out.outcome = answered ? "no_results" : "search_failed";
      return out;
    }
    for (const r of this.researchers) {
      try {
        out.researchCalls++;
        const res = await research(this.chat, query, recency, out.hits, now, r);
        const text = res.content?.trim() ?? "";
        const problems = res.finishReason === "length" ? ["cut off at the output limit"] : text ? summaryProblems(text) : ["empty reply"];
        if (!problems.length) {
          out.outcome = "ok";
          out.researchModel = r.model;
          out.summary = text;
          return out;
        }
        out.errors.push(`${r.model}: ${problems.join("; ")}`);
      } catch (err) {
        if (err instanceof ModelError && err.isDailyCap) {
          const t = this.deps.now();
          this.pausedUntil = (err.retryAfterSeconds ? new Date(t.getTime() + err.retryAfterSeconds * 1000) : nextUtcMidnight(t)).getTime();
          out.errors.push(`${r.model}: the research key reached its daily cap`);
          out.outcome = "research_capped";
          return out;
        }
        out.errors.push(`${r.model}: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
      }
    }
    out.outcome = "summary_failed";
    return out;
  }
}

/** What the bot sees: the summary, or plainly why there isn't one. Never a URL. */
export function searchResultText(r: WebSearchRecord, searchesLeft: number): string {
  const left = { searches_left_this_visit: searchesLeft };
  switch (r.outcome) {
    case "ok":
      return JSON.stringify({ search: r.query, summary: r.summary, ...left });
    case "no_results":
      return JSON.stringify({ search: r.query, summary: "The web search found nothing for that.", ...left });
    case "research_capped":
      return JSON.stringify({ search: r.query, error: "Web search is out of use until tomorrow. Carry on without it." });
    default:
      return JSON.stringify({ search: r.query, error: "The web search didn't work just now. Carry on without it.", ...left });
  }
}
