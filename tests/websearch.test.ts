import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { ModelError, type ChatModel, type ChatRequest, type ChatResponse } from "../src/runner/model.js";
import { loadQueries, runSearchProbe } from "../src/runner/searchprobe.js";
import {
  Exa,
  LangSearch,
  Linkup,
  pageText,
  researchBrief,
  researchPrompt,
  RESEARCHER,
  SearchError,
  searchResultText,
  summaryProblems,
  WebSearch,
  type SearchBackend,
  type SearchService,
} from "../src/runner/websearch.js";

// Web search: each service's request and how its answer is read, the
// research model's prompt, and the search probe's report. No network: every
// fetch is scripted.

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A fetch that records the request and answers with `status` and `json`. */
function scripted(status: number, json: unknown, sent: Sent[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(typeof json === "string" ? json : JSON.stringify(json), { status });
  }) as typeof fetch;
}

const NOW = new Date("2026-10-02T12:00:00Z");

async function main() {
  // ── Page text ──
  assert.equal(pageText("  a\n\n b\tc  "), "a b c", "whitespace collapsed");
  const long = pageText("word ".repeat(1000), 100);
  assert.ok(long.length <= 100 && long.endsWith("…") && !long.includes("wor…"), "cut at a word boundary");

  // ── LangSearch ──
  let sent: Sent[] = [];
  let r = await new LangSearch("LS-KEY", {
    fetch: scripted(
      200,
      {
        code: 200,
        data: {
          webPages: {
            value: [
              { name: "Fed holds rates", url: "https://www.reuters.com/markets/fed", text: "The Fed  held\nrates steady.", datePublished: "2026-09-16T18:00:00Z" },
              { name: "Snippet only", url: "https://example.org/a", snippet: "A snippet." },
              { name: "Nothing", url: "https://example.org/b" },
              { name: "No url", text: "orphan" },
            ],
          },
        },
      },
      sent
    ),
  }).search("fed rates", { recency: "month", now: NOW });
  assert.equal(sent[0]!.url, "https://api.langsearch.com/v1/web-search");
  assert.equal(sent[0]!.headers["Authorization"], "Bearer LS-KEY");
  assert.deepEqual(sent[0]!.body, {
    query: "fed rates",
    count: config.runner.web_search_results,
    contents: { text: { max_characters: config.runner.web_search_page_chars } },
    freshness: "oneMonth",
  });
  assert.deepEqual(r.hits, [
    { title: "Fed holds rates", url: "https://www.reuters.com/markets/fed", site: "reuters.com", published: "2026-09-16", crawled: true, text: "The Fed held rates steady." },
    { title: "Snippet only", url: "https://example.org/a", site: "example.org", published: null, text: "A snippet." },
  ], "pages without text or a URL are dropped; LangSearch's dates may be crawl dates");
  assert.equal(r.costDollars, null);
  sent = [];
  await new LangSearch("k", { fetch: scripted(200, { code: 200, data: { webPages: { value: [] } } }, sent) }).search("q", { recency: null, now: NOW });
  assert.ok(!("freshness" in sent[0]!.body), "no recency, no freshness");
  await assert.rejects(
    new LangSearch("k", { fetch: scripted(200, { code: 429, msg: "Daily allowance used" }, []) }).search("q", { recency: null, now: NOW }),
    (e: unknown) => e instanceof SearchError && e.status === 429 && e.isTransient && /Daily allowance used/.test(e.message),
    "an error inside a 200"
  );
  await assert.rejects(
    new LangSearch("k", { fetch: scripted(401, { message: "Invalid API key" }, []) }).search("q", { recency: null, now: NOW }),
    (e: unknown) => e instanceof SearchError && e.status === 401 && !e.isTransient && e.message === "langsearch 401: Invalid API key"
  );
  await assert.rejects(
    new LangSearch("k", { fetch: scripted(502, "<html>Bad gateway</html>", []) }).search("q", { recency: null, now: NOW }),
    (e: unknown) => e instanceof SearchError && e.isTransient && /502: <html>Bad gateway/.test(e.message)
  );
  await assert.rejects(
    new LangSearch("k", { fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch }).search("q", { recency: null, now: NOW }),
    (e: unknown) => e instanceof SearchError && e.status === null && /couldn't be reached/.test(e.message)
  );

  // ── Exa ──
  sent = [];
  r = await new Exa("EXA-KEY", {
    fetch: scripted(
      200,
      {
        results: [
          { title: "Comet 3I/ATLAS", url: "https://science.nasa.gov/comets/3i", publishedDate: "2025-10-30", highlights: ["It is interstellar.", "It came from afar."] },
          { title: "Full text", url: "https://example.com/x", text: "Whole page." },
        ],
        costDollars: { total: 0.007 },
      },
      sent
    ),
  }).search("comet", { recency: "week", now: NOW });
  assert.equal(sent[0]!.url, "https://api.exa.ai/search");
  assert.equal(sent[0]!.headers["x-api-key"], "EXA-KEY");
  assert.deepEqual(sent[0]!.body, {
    query: "comet",
    type: "auto",
    numResults: config.runner.web_search_results,
    contents: { highlights: { maxCharacters: config.runner.web_search_page_chars } },
    startPublishedDate: "2026-09-25T12:00:00.000Z",
  });
  assert.equal(r.hits[0]!.text, "It is interstellar. … It came from afar.", "highlights joined");
  assert.equal(r.hits[0]!.published, "2025-10-30");
  assert.equal(r.hits[1]!.text, "Whole page.", "text when there are no highlights");
  assert.equal(r.costDollars, 0.007);
  await assert.rejects(
    new Exa("k", { fetch: scripted(402, { error: "Insufficient credits" }, []) }).search("q", { recency: null, now: NOW }),
    (e: unknown) => e instanceof SearchError && e.status === 402 && !e.isTransient && e.message === "exa 402: Insufficient credits"
  );

  // ── Linkup ──
  sent = [];
  r = await new Linkup("LU-KEY", {
    fetch: scripted(
      200,
      {
        results: [
          { type: "text", name: "World Cup final", url: "https://www.bbc.co.uk/sport/final", content: "The final was played on 19 July." },
          { type: "image", name: "A picture", url: "https://example.com/p.jpg" },
        ],
      },
      sent
    ),
  }).search("world cup final", { recency: "year", now: NOW });
  assert.equal(sent[0]!.url, "https://api.linkup.so/v1/search");
  assert.equal(sent[0]!.headers["Authorization"], "Bearer LU-KEY");
  assert.deepEqual(sent[0]!.body, {
    q: "world cup final",
    depth: "standard",
    outputType: "searchResults",
    maxResults: config.runner.web_search_results,
    includeImages: false,
    fromDate: "2025-10-01",
  });
  assert.deepEqual(r.hits, [{ title: "World Cup final", url: "https://www.bbc.co.uk/sport/final", site: "bbc.co.uk", published: null, text: "The final was played on 19 July." }], "text results only");

  // ── The research model's prompt ──
  const brief = researchBrief("2026-10-02");
  assert.match(brief, /Today is 2026-10-02\./);
  assert.match(brief, /Never give URLs/);
  assert.match(brief, /Use only what the results say/);
  assert.ok(brief.includes(`at most ${config.runner.web_search_summary_chars} characters`));
  const prompt = researchPrompt("fed rates", "month", [
    { title: "Fed holds", url: "https://www.reuters.com/x", site: "reuters.com", published: "2026-09-16", text: "Held." },
    { title: "Undated", url: "https://example.org/y", site: "example.org", published: null, text: "Maybe." },
  ]);
  assert.equal(
    prompt,
    'The search: "fed rates" (results from the last month)\n\nThe results:\n\n[1] Fed holds\nSite: reuters.com. Published: 2026-09-16.\nHeld.\n\n[2] Undated\nSite: example.org. Published: no date given.\nMaybe.'
  );
  assert.ok(!prompt.includes("https://"), "the research model never sees a URL");

  // ── The search probe ──
  const queries = loadQueries();
  assert.ok(queries.length >= 15, "config/search-probe.yaml parses");
  const kinds = (k: string) => queries.filter((q) => q.kind === k).length;
  assert.ok(kinds("current") + kinds("recent") > queries.length * 0.7, "weighted toward current events and recent history");
  assert.ok(queries.some((q) => q.name === "nothing-there"), "and something that doesn't exist");

  // Three services: one answers, one finds nothing, one fails once and then for good.
  const searched: string[] = [];
  const backend = (service: SearchService, search: SearchBackend["search"]): SearchBackend => ({ service, search });
  let flaky = 0;
  const backends = [
    backend("langsearch", async (q, o) => {
      searched.push(`langsearch ${q} ${o.recency ?? "any"}`);
      return {
        hits: [
          { title: "One | two", url: "https://a.example/1", site: "a.example", published: "2026-09-30", text: "Fact one." },
          { title: "Old", url: "https://b.example/2", site: "b.example", published: "2026-01-02", text: "Fact two." },
        ],
        costDollars: null,
      };
    }),
    backend("exa", async () => ({ hits: [], costDollars: 0.007 })),
    backend("linkup", async () => {
      flaky++;
      throw new SearchError("linkup 503: busy", 503);
    }),
  ];
  const researched: ChatRequest[] = [];
  const reply = (content: string | null, finishReason = "stop"): ChatResponse => ({
    content,
    toolCalls: [],
    finishReason,
    usage: { promptTokens: 10, completionTokens: 50, reasoningTokens: 0, cachedTokens: 0 },
  });
  const chat: ChatModel = {
    async complete(req) {
      researched.push(req);
      return reply("Fact one, says a.example (2026-09-30), ```odd```.");
    },
  };
  const slept: number[] = [];
  const logged: string[] = [];
  const clock = { t: NOW.getTime() };
  const deps = { backends, chat, now: () => new Date((clock.t += 500)), sleep: async (ms: number) => void slept.push(ms), log: (l: string) => logged.push(l) };
  const two = [
    { name: "fed-rates", kind: "current" as const, query: "fed rates", recency: "month" as const, check: "Check the range." },
    { name: "etymology", kind: "other" as const, query: "quarantine" },
  ];
  let report = await runSearchProbe(deps, { queries: two, skipped: [] });
  assert.deepEqual(searched, ["langsearch fed rates month", "langsearch quarantine any"]);
  assert.equal(flaky, 4, "a transient failure is retried once");
  assert.deepEqual(slept, [config.runner.retry_wait_seconds * 1000, config.runner.retry_wait_seconds * 1000]);
  assert.equal(researched.length, 2, "a summary only where there are results");
  assert.equal(researched[0]!.model, RESEARCHER.model);
  assert.equal(researched[0]!.reasoningEffort, RESEARCHER.effort);
  assert.match(researched[0]!.messages[1]!.content ?? "", /^The search: "fed rates" \(results from the last month\)/);
  assert.match(report, /^# Search probe, 2026-10-02 /);
  assert.match(report, /- Services: langsearch, exa, linkup\.\n- Queries: 2 \(1 current events, 0 recent history, 1 other\)/);
  assert.match(report, /- Research model: tencent\/hy3, effort low\. It writes a summary/);
  assert.match(report, /\| langsearch \| 2 \| 0 \| 0 \| 4 \| 100% \| [\d.]+s \| – \|/, "the service table");
  assert.match(report, /\| exa \| 2 \| 0 \| 2 \| 0 \| – \| [\d.]+s \| \$0\.0140 \|/, "costs add up");
  assert.match(report, /\| tencent\/hy3 \| low \| 2 \| 2 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 49 \| [\d.]+s \|/, "the research model table");
  assert.match(report, /\| linkup \| 2 \| 2 \|/);
  assert.match(report, /\| fed-rates \| current \| 2 results, 2 dated, newest 2026-09-30, [\d.]+s \| 0 results, [\d.]+s \| search failed \|/, "the query table");
  assert.match(report, /## fed-rates: "fed rates"\n\n\*current events, results from the last month\.\*\n\nCheck: Check the range\./);
  assert.match(report, /### fed-rates: langsearch\n\n\*2 results, [\d.]+s\*\n\n1\. \*\*One \| two\*\*, a\.example, 2026-09-30  \n   Fact one\./);
  assert.match(report, /#### fed-rates: langsearch, tencent\/hy3, effort low\n\n\*[\d.]+s, 49 characters\*\n\n````text\nFact one, says a\.example \(2026-09-30\), ```odd```\.\n````/, "fenced so the text can't close it");
  assert.match(report, /### fed-rates: exa\n\n\*0 results, [\d.]+s, \$0\.0070\*\n\nNo summary: no results\./);
  assert.match(report, /### fed-rates: linkup\n\n\*failed, [\d.]+s\*\. \*\*linkup 503: busy\*\*/);
  assert.match(report, /## etymology: "quarantine"\n\n\*other, any age\.\*/);
  assert.match(report, /## The research model's instructions\n\n```text\nYou are a research assistant/);
  assert.ok(!report.includes("Stopped early"));
  assert.ok(logged.some((l) => l.startsWith('fed-rates: "fed rates"')));

  // A summary that runs out of room, and a key at its daily cap.
  let calls = 0;
  const capping: ChatModel = {
    async complete() {
      if (++calls === 1) return reply(null, "length");
      throw new ModelError("cap", 429, "daily_rpd_limit_exceeded", null);
    },
  };
  report = await runSearchProbe({ ...deps, chat: capping }, { queries: [...two, { name: "third", kind: "recent", query: "never searched" }], skipped: ["exa"] });
  assert.match(report, /Skipped, with no key: exa\./);
  assert.match(report, /\*\*Stopped early:\*\* The probe key reached its daily cap\./);
  assert.match(report, /\*[\d.]+s\*\. \*\*used the whole output limit without writing anything\*\*/);
  assert.match(report, /\*[\d.]+s\*\. \*\*not written: the probe key reached its daily cap\*\*/, "the capped search's results are still reported");
  assert.equal(calls, 2, "no call after the cap");
  assert.ok(!report.includes("## third"), "and the run stops there");

  // Several research models on the same results: one refuses
  // reasoning_effort and runs at default from then on, one thinks aloud, and
  // the same model can run at two efforts.
  const asked: string[] = [];
  const models: ChatModel = {
    async complete(req) {
      asked.push(`${req.model}@${req.reasoningEffort}`);
      if (req.model === "picky/m" && req.reasoningEffort !== "default") throw new ModelError("400", 400, "unsupported_reasoning_effort", null);
      if (req.model === "chatty/m") return reply("Fact one (a.example, 2026-09-30). Wait, careful: let me check that again");
      return reply(`Fact one (a.example, 2026-09-30), by ${req.model} at ${req.reasoningEffort}.`);
    },
  };
  const researchers = [
    { model: "steady/m", effort: "default" as const },
    { model: "steady/m", effort: "low" as const },
    { model: "picky/m", effort: "low" as const },
    { model: "chatty/m", effort: "low" as const },
  ];
  report = await runSearchProbe({ ...deps, backends: [backends[0]!], chat: models }, { queries: two, skipped: [], researchers });
  assert.equal(asked.filter((a) => a.startsWith("picky/m@low")).length, 1, "a refused effort is found out once");
  assert.equal(asked.filter((a) => a === "picky/m@default").length, 2, "then default for every summary");
  assert.equal(asked.length, 4 * 2 + 1, "every model, every result set, plus the one refusal");
  assert.match(report, /- Research models: steady\/m, effort default; steady\/m, effort low; picky\/m, effort low; chatty\/m, effort low\. Each writes/);
  assert.match(report, /\| steady\/m \| default \| 2 \| 2 \| 0 \| 0 \|[^\n]*\n\| steady\/m \| low \| 2 \| 2 \| 0 \| 0 \|/, "one model at two efforts gets two rows");
  assert.match(report, /\| chatty\/m \| low \| 2 \| 2 \| 0 \| 2 \| 2 \| 2 \| 0 \| 0 \|/, "problems counted");
  assert.match(report, /#### fed-rates: langsearch, steady\/m, effort default\n[\s\S]*#### fed-rates: langsearch, steady\/m, effort low\n[\s\S]*#### fed-rates: langsearch, picky\/m, effort default\n[\s\S]*#### fed-rates: langsearch, chatty\/m, effort low\n\n\*[\d.]+s, \d+ characters\*\. \*\*thinking aloud; doesn't end cleanly\*\*/, "in the order asked, with the effort used");

  // ── Summary problems ──
  const fine = "The Fed raised rates to 3.75%–4% on 16 September (Reuters, 2026-09-16). Venice extended the wait to 40 days in 1448 (Wikipedia).";
  assert.deepEqual(summaryProblems(fine), [], "the wait to 40 days is not thinking aloud");
  assert.deepEqual(summaryProblems("Polls show Democrats ahead. Let me stick close—wait exact readings"), ["thinking aloud", "doesn't end cleanly"]);
  assert.deepEqual(summaryProblems("Regular-season outcomes: Rays first. Brewers confirmed elsewhere soon enough..."), ["doesn't end cleanly"]);
  const salad = `Spain won. ${"steadfast neutrality invoked responses accordingly ".repeat(40)}stop.`;
  assert.deepEqual(summaryProblems(salad), [`longer than asked (${salad.length} characters)`, `a ${(salad.length - 11).toLocaleString("en-US")}-character sentence`]);

  // ── The bots' web search: fallbacks ──
  const hitsA = [{ title: "Fed", url: "https://www.reuters.com/fed", site: "reuters.com", published: "2026-09-16", text: "Rates rose." }];
  const svc = (service: SearchService, search: SearchBackend["search"]): SearchBackend => ({ service, search });
  const failing = svc("exa", async () => {
    throw new SearchError("exa 402: Insufficient credits", 402);
  });
  const empty = svc("exa", async () => ({ hits: [], costDollars: 0.007 }));
  const good = svc("langsearch", async () => ({ hits: hitsA, costDollars: null }));
  const scriptedChat = (...replies: (ChatResponse | Error)[]): ChatModel & { asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      async complete(req) {
        asked.push(req.model);
        const next = replies.shift();
        if (!next) throw new Error("called too often");
        if (next instanceof Error) throw next;
        return next;
      },
    };
  };
  const two2 = [
    { model: "tencent/hy3", effort: "low" as const },
    { model: "deepseek/deepseek-v4-pro", effort: "low" as const },
  ];
  const at = { now: () => NOW };

  // Exa out of credit: LangSearch answers, Hy3 summarizes.
  let chat2 = scriptedChat(reply("Rates rose to 3.75%–4% (Reuters, 2026-09-16)."));
  let rec = await new WebSearch([failing, good], chat2, at, two2).search("fed rates", "month");
  assert.equal(rec.outcome, "ok");
  assert.equal(rec.service, "langsearch");
  assert.equal(rec.researchModel, "tencent/hy3");
  assert.deepEqual(rec.errors, ["exa 402: Insufficient credits"]);
  let shown = searchResultText(rec, 1);
  assert.deepEqual(JSON.parse(shown), { search: "fed rates", summary: "Rates rose to 3.75%–4% (Reuters, 2026-09-16).", searches_left_this_visit: 1 });
  assert.ok(!shown.includes("https://"), "the bot never sees a URL");

  // Exa finds nothing: LangSearch is tried. Hy3 thinks aloud and V4 Pro times out... then nothing usable.
  chat2 = scriptedChat(reply("Rates rose. Wait, let me check"), new ModelError("timed out", null, null, null));
  rec = await new WebSearch([empty, good], chat2, at, two2).search("fed rates", null);
  assert.equal(rec.outcome, "summary_failed");
  assert.deepEqual(chat2.asked, ["tencent/hy3", "deepseek/deepseek-v4-pro"]);
  assert.match(rec.errors.join(" | "), /^exa: no results \| tencent\/hy3: thinking aloud; doesn't end cleanly \| deepseek\/deepseek-v4-pro: timed out$/);
  assert.match(searchResultText(rec, 0), /didn't work just now/);

  // A summary cut off at the output limit goes to the next model.
  chat2 = scriptedChat(reply("Rates rose and", "length"), reply("Rates rose (Reuters, 2026-09-16)."));
  rec = await new WebSearch([good], chat2, at, two2).search("fed rates", null);
  assert.equal(rec.researchModel, "deepseek/deepseek-v4-pro");
  assert.equal(rec.researchCalls, 2);

  // Nothing anywhere, and every service down.
  rec = await new WebSearch([empty], scriptedChat(), at, two2).search("Harlow Springs", null);
  assert.equal(rec.outcome, "no_results");
  assert.equal(JSON.parse(searchResultText(rec, 1)).summary, "The web search found nothing for that.");
  rec = await new WebSearch([failing], scriptedChat(), at, two2).search("anything", null);
  assert.equal(rec.outcome, "search_failed");

  // The research key's daily cap stops searches until it resets.
  const clock2 = { t: NOW.getTime() };
  const web = new WebSearch([good], scriptedChat(new ModelError("cap", 429, "daily_rpd_limit_exceeded", null)), { now: () => new Date(clock2.t) }, two2);
  rec = await web.search("fed rates", null);
  assert.equal(rec.outcome, "research_capped");
  assert.equal(web.ready, false);
  rec = await web.search("again", null);
  assert.equal(rec.outcome, "research_capped", "no search, no call");
  assert.equal(rec.service, null);
  assert.match(searchResultText(rec, 1), /out of use until tomorrow/);
  clock2.t = Date.parse("2026-10-03T00:00:01Z");
  assert.equal(web.ready, true, "back after midnight UTC");

  // LangSearch's dates are labelled for the research model.
  assert.match(researchPrompt("q", null, [{ ...hitsA[0]!, crawled: true }]), /Dated 2026-09-16, which may be when the page was seen rather than published\./);
}

main()
  .then(() => console.log("websearch: all tests passed"))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
