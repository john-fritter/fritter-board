import assert from "node:assert/strict";
import type { InboxJson } from "../src/runner/board.js";
import { ModelError, modelIdProblem, NanoGptModel, parseUsage, type ChatModel, type ChatRequest, type ChatResponse } from "../src/runner/model.js";
import { probeModel } from "../src/runner/probe.js";
import { firstWake, inWindow, isAwake, localMinutes, nextWake, parseTimeOfDay } from "../src/runner/schedule.js";
import { loadScenarios, runVoiceProbe, sampleFlags, scenarioPrompt, voiceSystemPrompt } from "../src/runner/voice.js";
import { earlyWakeReason, extractJson, visitAllowance } from "../src/runner/wake.js";

// The runner's pure parts: waking windows and schedules, the NanoGPT client's
// requests and errors, the early-wake rule, decision parsing, and the probes.

const TZ = "America/Los_Angeles";
const at = (iso: string) => new Date(iso);

async function main() {
  // ── Times of day and windows ──
  assert.equal(parseTimeOfDay("08:00"), 480);
  assert.equal(parseTimeOfDay("00:00:00"), 0, "Postgres TIME");
  assert.equal(parseTimeOfDay("24:00"), 0);
  assert.throws(() => parseTimeOfDay("25:00"));
  const day = { start: 480, end: 0 }; // 8am to midnight
  assert.ok(inWindow(480, day) && inWindow(23 * 60 + 59, day) && !inWindow(0, day) && !inWindow(479, day), "a window running to midnight");
  assert.ok(inWindow(0, { start: 0, end: 0 }) && inWindow(700, { start: 0, end: 0 }), "start = end is all day");
  assert.ok(inWindow(60, { start: 22 * 60, end: 120 }) && !inWindow(200, { start: 22 * 60, end: 120 }), "past midnight");
  assert.ok(inWindow(600, { start: 540, end: 1020 }) && !inWindow(1020, { start: 540, end: 1020 }), "the end is exclusive");

  // 2026-09-27 is PDT (UTC-7): 15:00Z is 8:00am.
  assert.equal(localMinutes(at("2026-09-27T15:00:00Z"), TZ), 480);
  assert.equal(localMinutes(at("2026-12-01T16:00:00Z"), TZ), 480, "PST (UTC-8) in winter");

  // ── Next wakes ──
  const s = { ...day, intervalMin: 120, intervalMax: 300 };
  const noon = at("2026-09-27T19:00:00Z"); // 12:00 PDT
  assert.equal(nextWake(noon, s, () => 0, TZ).getTime(), noon.getTime() + 120 * 60_000, "the shortest interval");
  assert.equal(nextWake(noon, s, () => 1, TZ).getTime(), noon.getTime() + 300 * 60_000, "the longest");
  const late = at("2026-09-28T05:00:00Z"); // 22:00 PDT: +2h lands at midnight, outside
  const moved = nextWake(late, s, () => 0.5, TZ);
  assert.ok(isAwake(moved, s, TZ), "moved into the window");
  const opens = at("2026-09-28T15:00:00Z"); // 8:00am the next day
  assert.ok(moved >= opens && moved.getTime() <= opens.getTime() + 60 * 60_000, "within the spread after it opens");
  for (let i = 0; i < 50; i++) {
    const w = nextWake(at("2026-11-01T06:30:00Z"), s, Math.random, TZ); // the night clocks go back
    assert.ok(isAwake(w, s, TZ), "always inside the window, DST included");
  }
  const first = firstWake(noon, s, () => 0, TZ);
  assert.equal(first.getTime(), noon.getTime(), "a first wake can come at once");

  // ── The NanoGPT client ──
  let sent: { url: string; body: Record<string, unknown>; auth: string } | null = null;
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}): typeof fetch =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      sent = {
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        auth: new Headers(init?.headers).get("authorization") ?? "",
      };
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
    }) as typeof fetch;

  let model = new NanoGptModel("sk-test", {
    fetch: reply(200, {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "read_thread", arguments: '{"thread_id":3}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 1200, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 25 }, prompt_tokens_details: { cached_tokens: 800 } },
    }),
  });
  let res = await model.complete({
    model: "vendor/model-a",
    messages: [{ role: "user", content: "hi" }],
    reasoningEffort: "low",
    tools: [{ type: "function", function: { name: "read_thread", parameters: { type: "object" } } }],
  });
  const req = sent!;
  assert.equal(req.url, "https://api.nano-gpt.com/api/subscription/v1/chat/completions", "the subscription URL");
  assert.equal(req.auth, "Bearer sk-test");
  assert.equal(req.body["reasoning_effort"], "low");
  assert.equal(req.body["include_usage"], true, "usage must be asked for");
  assert.equal(req.body["parallel_tool_calls"], undefined, "several calls a turn are allowed; the wake refuses writes among them");
  assert.equal(req.body["tool_choice"], "auto");
  assert.deepEqual(req.body["reasoning"], { exclude: true });
  for (const k of ["provider", "billing_mode", "billingMode"]) assert.equal(req.body[k], undefined, `never ${k}`);
  assert.equal(res.toolCalls[0]!.function.name, "read_thread");
  assert.deepEqual(res.usage, { promptTokens: 1200, completionTokens: 40, reasoningTokens: 25, cachedTokens: 800 });

  model = new NanoGptModel("k", { fetch: reply(200, { choices: [{ message: { content: "{}" } }] }) });
  await model.complete({
    model: "m",
    messages: [],
    reasoningEffort: "none",
    jsonSchema: { name: "decision", schema: { type: "object" } },
  });
  assert.deepEqual(sent!.body["response_format"], { type: "json_schema", json_schema: { name: "decision", strict: true, schema: { type: "object" } } });
  assert.equal(sent!.body["tools"], undefined, "no tools unless given");
  assert.equal(sent!.body["reasoning_effort"], "none", "none is sent: it turns reasoning off");
  await model.complete({ model: "m", messages: [], reasoningEffort: "default" });
  assert.equal(sent!.body["reasoning_effort"], undefined, "default sends no reasoning_effort");
  assert.equal(sent!.body["reasoning"], undefined, "nor the reasoning object");
  assert.deepEqual(parseUsage({ prompt_tokens: 5, reasoning_tokens: 3, cache_read_input_tokens: 2 }), {
    promptTokens: 5,
    completionTokens: 0,
    reasoningTokens: 3,
    cachedTokens: 2,
  });

  const failWith = async (status: number, body: unknown, headers: Record<string, string> = {}) => {
    const m = new NanoGptModel("k", { fetch: reply(status, body, headers) });
    try {
      await m.complete({ model: "m", messages: [], reasoningEffort: "low" });
    } catch (err) {
      assert.ok(err instanceof ModelError);
      return err;
    }
    throw new Error("expected a ModelError");
  };
  let err = await failWith(
    429,
    { error: { message: "Daily request limit exceeded (60/60). Resets at midnight UTC.", code: "daily_rpd_limit_exceeded", type: "rate_limit_error" } },
    { "Retry-After": "3600" }
  );
  assert.ok(err.isDailyCap && !err.isTransient, "the daily cap isn't retried");
  assert.equal(err.retryAfterSeconds, 3600);
  err = await failWith(429, { error: { message: "slow down" } });
  assert.ok(!err.isDailyCap && err.isTransient);
  assert.ok((await failWith(503, "upstream down")).isTransient);
  assert.ok(!(await failWith(400, { error: { message: "bad model", code: "invalid_model" } })).isTransient, "a bad request isn't");
  err = await failWith(400, { error: { message: "This model does not support reasoning_effort", code: "unsupported_reasoning_effort" } });
  assert.ok(err.isUnsupportedEffort && !err.isTransient);
  const offline = new NanoGptModel("k", { fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
  await assert.rejects(offline.complete({ model: "m", messages: [], reasoningEffort: "low" }), (e: unknown) => e instanceof ModelError && e.isTransient);

  assert.equal(modelIdProblem("vendor/model-a"), null);
  assert.equal(modelIdProblem("vendor/model:thinking"), null, "thinking variants are models of their own");
  for (const bad of ["vendor/m:online", "vendor/m:memory-30", "vendor/m:fast", "vendor/m:cheap", "vendor/m:caching", ""]) {
    assert.notEqual(modelIdProblem(bad), null, `${bad} is refused`);
  }

  // ── Early wake: John's PMs and @mentions only ──
  const since = at("2026-09-27T18:00:00Z");
  const inbox = (over: Partial<InboxJson>): InboxJson => ({
    since: since.toISOString(),
    now: "2026-09-27T19:00:00Z",
    you: { name: "Testbot", writes_left: { this_hour: 10, today: 50 } },
    unread_pms: [],
    replies: [],
    mentions: [],
    active_threads: [],
    new_articles: [],
    ...over,
  });
  const post = (author: string, flags: { mentions_you?: boolean; quotes_you?: boolean }) => ({
    post_id: 1, thread_id: 1, thread: "Zoning", board: "news", author, at: "2026-09-27T18:30:00Z", ...flags,
  });
  const names = ["John"];
  assert.equal(earlyWakeReason(inbox({}), since, names), null);
  assert.match(earlyWakeReason(inbox({ mentions: [post("John", { mentions_you: true })] }), since, names)!, /@mention from John/);
  assert.match(earlyWakeReason(inbox({ replies: [post("john", { mentions_you: true, quotes_you: true })] }), since, names)!, /@mention/, "a reply that also @mentions, any case");
  assert.equal(earlyWakeReason(inbox({ replies: [post("John", { quotes_you: true })] }), since, names), null, "a quote alone doesn't");
  assert.equal(earlyWakeReason(inbox({ replies: [post("John", {})] }), since, names), null, "nor posting after the bot");
  assert.equal(earlyWakeReason(inbox({ mentions: [post("Dan", { mentions_you: true })] }), since, names), null, "nor anyone else");
  const pm = (w: string[], lastAt: string) => ({ conversation_id: 4, with: w, unread: 1, last_at: lastAt });
  assert.match(earlyWakeReason(inbox({ unread_pms: [pm(["John"], "2026-09-27T18:30:00Z")] }), since, names)!, /PM from John/);
  assert.equal(earlyWakeReason(inbox({ unread_pms: [pm(["John"], "2026-09-27T17:00:00Z")] }), since, names), null, "an old unread PM already had its chance");
  assert.equal(earlyWakeReason(inbox({ unread_pms: [pm(["Dan"], "2026-09-27T18:30:00Z")] }), since, names), null);
  assert.equal(earlyWakeReason(inbox({ mentions: [post("John", { mentions_you: true })] }), since, []), null, "an empty list wakes no one");

  // ── A visit's allowance: more for what's addressed to the bot ──
  const per = { extra_steps_per_pm: 2, extra_steps_per_mention: 1, steps_per_wake_max: 10, extra_writes_per_item: 1, writes_per_wake_max: 3 };
  const own = { steps: 5, writes: 1 };
  const allow = (over: Partial<InboxJson>, o = own) => visitAllowance(o, inbox(over), per);
  const conv = (w: string) => pm([w], "2026-09-27T18:30:00Z");
  const both = post("Dan", { quotes_you: true, mentions_you: true });
  assert.deepEqual(allow({}), own, "nothing waiting");
  assert.deepEqual(allow({ replies: [post("Dan", {})] }), own, "posting after the bot doesn't count");
  assert.deepEqual(allow({ unread_pms: [conv("Dan")] }), { steps: 7, writes: 2 }, "a PM conversation");
  assert.deepEqual(allow({ replies: [both], mentions: [both] }), { steps: 6, writes: 2 }, "a post in both lists counts once");
  assert.deepEqual(allow({ unread_pms: [conv("Dan"), conv("Ann")], mentions: [both] }), { steps: 10, writes: 3 });
  const crowd = Array.from({ length: 7 }, (_, i) => ({ ...both, post_id: 10 + i }));
  assert.deepEqual(allow({ unread_pms: [conv("Dan"), conv("Ann")], mentions: crowd }), { steps: 10, writes: 3 }, "steps_per_wake_max and writes_per_wake_max in all");
  assert.deepEqual(allow({ unread_pms: [conv("Dan")] }, { steps: 12, writes: 4 }), { steps: 12, writes: 4 }, "a bot's own higher settings stand");

  // ── Decisions ──
  assert.deepEqual(extractJson('{"action":"nothing"}'), { action: "nothing" });
  assert.deepEqual(extractJson('Here you go:\n```json\n{"action":"nothing","reason":"quiet"}\n```'), { action: "nothing", reason: "quiet" });
  assert.throws(() => extractJson("I'd rather not."));

  // ── The probe, against a scripted model ──
  const scripted = (tools: boolean, json: boolean, reasoning: [number, number]): ChatModel => ({
    async complete(r: ChatRequest): Promise<ChatResponse> {
      const usage = { promptTokens: 10, completionTokens: 5, reasoningTokens: 0, cachedTokens: 0 };
      const text = (content: string, reasoningTokens = 0): ChatResponse => ({ content, toolCalls: [], finishReason: "stop", usage: { ...usage, reasoningTokens } });
      if (r.tools) {
        const last = r.messages[r.messages.length - 1]!;
        if (last.role === "tool") return text("It's foggy and 58F in Portland.");
        return tools
          ? { content: null, toolCalls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: '{"city":"Portland"}' } }], finishReason: "tool_calls", usage }
          : text("I can't check that.");
      }
      if (r.jsonSchema) return text(json ? '{"answer":42}' : "42");
      if (r.messages[0]!.content!.startsWith("A ferry")) return text("8:10am", r.reasoningEffort === "high" ? reasoning[1] : reasoning[0]);
      return text("ready");
    },
  });
  let p = await probeModel(scripted(true, true, [100, 900]), "good");
  assert.match(p.reachable, /^yes/);
  assert.equal(p.tools, "yes");
  assert.match(p.reasoning, /^honored/);
  assert.equal(p.json, "yes");
  assert.equal(p.suggested, "tools");
  p = await probeModel(scripted(false, true, [0, 0]), "no-tools");
  assert.equal(p.tools, "no tool call");
  assert.equal(p.reasoning, "no reasoning tokens reported");
  assert.equal(p.suggested, "single_shot");
  // A model that refuses reasoning_effort is probed without it.
  const good = scripted(true, true, [100, 900]);
  const efforts: string[] = [];
  p = await probeModel(
    {
      async complete(r: ChatRequest) {
        efforts.push(r.reasoningEffort);
        if (r.reasoningEffort !== "default") {
          throw new ModelError("NanoGPT 400: unsupported", 400, "unsupported_reasoning_effort", null);
        }
        return good.complete(r);
      },
    },
    "no-effort"
  );
  assert.match(p.reachable, /^yes, .*\(refuses reasoning_effort\)$/);
  assert.equal(p.tools, "yes");
  assert.equal(p.reasoning, "refuses reasoning_effort");
  assert.equal(p.json, "yes");
  assert.equal(p.suggested, "tools, --effort default");
  assert.deepEqual(efforts.slice(0, 2), ["low", "default"], "one refusal, then default throughout");
  assert.ok(efforts.slice(1).every((e) => e === "default"));
  p = await probeModel({ complete: async () => { throw new ModelError("nope", 404, "model_not_found", null); } }, "gone");
  assert.equal(p.reachable, "no: error 404 model_not_found");
  assert.equal(p.suggested, "don't use");

  // ── The voice probe ──
  const scenarios = loadScenarios();
  assert.deepEqual(scenarios.map((sc) => sc.name), ["reply", "weekend", "news", "new_thread"], "config/voice-probe.yaml parses");
  const news = JSON.parse(scenarioPrompt(scenarios[2]!).split("\n\n")[0]!) as { thread: { board: string; article?: { title: string } } };
  assert.equal(news.thread.board, "news");
  assert.match(news.thread.article?.title ?? "", /licensed/, "a News thread shows its article");
  const replyPrompt = scenarioPrompt(scenarios[0]!);
  const shown = JSON.parse(replyPrompt.slice(0, replyPrompt.indexOf("\n\n"))) as { thread: { title: string }; posts: { number: number; author: { name: string; bot?: boolean } }[] };
  assert.match(shown.thread.title, /Carnegie/, "the thread as read_thread shows it");
  assert.deepEqual(shown.posts.map((x) => [x.number, x.author.name, x.author.bot ?? false]), [[1, "John", false], [2, "Bickerstaff", true], [3, "John", false]]);
  assert.ok(replyPrompt.endsWith(scenarios[0]!.ask), "then what to write");
  const newThread = scenarios.find((sc) => sc.name === "new_thread")!;
  assert.equal(scenarioPrompt(newThread), newThread.ask, "a scenario without a thread is just the ask");

  // Flags: what a member shouldn't do, checked mechanically.
  const library = scenarios[0]!;
  assert.deepEqual(sampleFlags('[quote="John" post=1003]The only entrance is up fourteen steps, and the "temporary" ramp[/quote] quite. @Bickerstaff agrees.', library), [], "a real quote, fairly trimmed");
  assert.deepEqual(sampleFlags('[quote="John" post=1001]Saw this in a regional paper... I honestly don\'t know what I think.[/quote]', library), [], "pieces joined by an ellipsis");
  assert.deepEqual(sampleFlags('[quote="Bickerstaff" post=1002]Libraries are obsolete and should all be closed.[/quote]', library), ["quote not in the thread"]);
  assert.deepEqual(sampleFlags('[quote="John" post=1002]Nine million to mend a building[/quote]', library), ["quote not in the thread"], "the right words, the wrong author");
  assert.deepEqual(sampleFlags('[quote="Sexton" post=1]I keep a ledger of abandoned railways.[/quote]', newThread), ["quote with nothing to quote"]);
  assert.deepEqual(sampleFlags("[quote]something nobody here ever said[/quote] and [quote]no end", library), ["quote not in the thread", "unbalanced quote tags"]);
  assert.deepEqual(sampleFlags("See [url=https://example.com/story]this[/url], @Maple and @John.", library), ["link", "@Maple: not in the thread"]);
  assert.deepEqual(sampleFlags("This is **bold**.", library), ["markdown"]);
  assert.deepEqual(
    sampleFlags('[quote="John" post=1003]The only entrance is up fourteen steps[/quote]\nTrue.\n[quote="Bickerstaff" post=1002]nine million to mend a building[/quote]\nCheap.', library),
    [],
    "two quotes, each from its own post"
  );
  assert.deepEqual(sampleFlags("[list][*]one[*]two", library), ["unbalanced list tags"]);
  assert.deepEqual(sampleFlags("[list=1][*]one\n[*]two[/list]\n- a dash line is fine as text", library), []);
  const system = voiceSystemPrompt("THE MEMBER BRIEF", "Your name is Penny.");
  assert.ok(system.includes("BBCode, not Markdown") && system.indexOf("THE MEMBER BRIEF") < system.indexOf("Your name is Penny."), "mechanics, brief, persona");

  // Two models write as two personas; one refuses reasoning_effort, one is gone.
  const seen: { model: string; effort: string; system: string }[] = [];
  const voiced = (content: string | null, finishReason = "stop"): ChatResponse => ({
    content,
    toolCalls: [],
    finishReason,
    usage: { promptTokens: 10, completionTokens: 50, reasoningTokens: 0, cachedTokens: 0 },
  });
  const cast: ChatModel = {
    async complete(r) {
      if (r.model === "gone") throw new ModelError("nope", 404, "model_not_found", null);
      if (r.model === "picky" && r.reasoningEffort !== "default") throw new ModelError("400", 400, "unsupported_reasoning_effort", null);
      if (r.messages[0]!.role !== "system") return good.complete(r);
      seen.push({ model: r.model, effort: r.reasoningEffort, system: r.messages[0]!.content });
      if (r.model === "picky") return voiced(null, "length");
      return voiced(`[b]${r.messages[0]!.content.includes("Penny") ? "Penny" : "Sexton"}[/b] says \`\`\`hi\`\`\``);
    },
  };
  const logged: string[] = [];
  const clock = { t: Date.parse("2026-09-30T12:00:00Z") };
  const deps = { chat: cast, now: () => new Date((clock.t += 1500)), sleep: async () => {}, log: (l: string) => logged.push(l) };
  const personas = [
    { name: "penny", text: "Your name is Penny." },
    { name: "sexton", text: "Your name is Sexton." },
  ];
  const input = { models: ["good", "picky", "gone"], personas, scenarios, memberBrief: "BRIEF", briefSource: "as shipped" };
  let report = await runVoiceProbe(deps, input);
  assert.equal(seen.length, 2 * 2 * 4, "each reachable model, each persona, each scenario");
  assert.ok(seen.every((x) => x.system.includes("BRIEF")));
  assert.deepEqual([...new Set(seen.filter((x) => x.model === "picky").map((x) => x.effort))], ["default"], "at the effort the mechanics found");
  assert.match(report, /^# Voice probe, 2026-09-30 /);
  assert.match(report, /\| gone +\| no: error 404 model_not_found/, "the mechanics table");
  assert.match(report, /Unreachable, so no samples: gone\./);
  assert.match(report, /\| model \| persona \| reply \| weekend \| news \| new_thread \|\n\|---\|---\|---\|---\|---\|---\|\n\| good \| penny \| 26 \| 26 \| 26 \| 26 \|/, "a summary row per model and persona");
  assert.match(report, /\| picky \| sexton \| used the whole output limit without writing anything \|/);
  assert.match(report, /## penny[\s\S]*### penny: reply[\s\S]*#### good[\s\S]*````text\n\[b\]Penny\[\/b\] says ```hi```\n````/, "grouped by persona, fenced so the text can't close it");
  assert.match(report, /#### picky\n\n\*[^\n]*effort default\*\. \*\*used the whole output limit without writing anything\*\*/);
  assert.ok(!report.includes("Stopped early"));
  assert.ok(logged.some((l) => l.startsWith("penny, reply: good")));

  // A key at its daily cap stops the run, and the report says so.
  let calls = 0;
  const capping: ChatModel = {
    async complete(r) {
      if (++calls > 8) throw new ModelError("cap", 429, "daily_rpd_limit_exceeded", null);
      return cast.complete(r);
    },
  };
  report = await runVoiceProbe({ ...deps, chat: capping }, { ...input, models: ["good", "picky"] });
  assert.match(report, /\*\*Stopped early:\*\* The probe key reached its daily cap\./);
  assert.equal(calls, 9, "no call after the cap");

  // Without the checks, at two efforts: every model is sampled at each, and a
  // model that refuses reasoning_effort is found out once and then sampled at
  // default alone.
  seen.length = 0;
  report = await runVoiceProbe(deps, { ...input, models: ["good", "picky"], efforts: ["low", "high"], checks: false });
  const effortsOf = (model: string) => seen.filter((x) => x.model === model).map((x) => x.effort);
  assert.equal(effortsOf("good").length, 2 * 4 * 2, "both efforts, every persona and scenario");
  assert.deepEqual([...new Set(effortsOf("good"))], ["low", "high"]);
  assert.deepEqual([...new Set(effortsOf("picky"))], ["default"], "refused once, then default");
  assert.equal(effortsOf("picky").length, 2 * 4, "once per persona and scenario");
  assert.match(report, /## Mechanics\n\nNot checked this run \(--no-checks\)\./);
  assert.match(report, /Samples are written at low and high effort/);
  assert.match(report, /#### good, effort low[\s\S]*#### good, effort high[\s\S]*#### picky, effort default/, "labelled by effort");
  assert.match(report, /\| model \| effort \| persona \| reply \|[^\n]*\n[^\n]*\n\| good \| low \| penny \| 26 \|[^\n]*\n\| good \| high \| penny \| 26 \|/, "a summary row per effort");
  assert.match(report, /\| picky \| default \| penny \|/);
}

main()
  .then(() => console.log("runner: all tests passed"))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
