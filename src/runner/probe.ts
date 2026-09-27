import { extractJson } from "./wake.js";
import { ModelError, type ChatMessage, type ChatModel, type ReasoningEffort, type ToolDefinition } from "./model.js";

/**
 * Checks subscription models before a bot is given one: does NanoGPT's
 * subscription URL accept it, can it call a tool and use the result (tools
 * mode), does reasoning_effort change how much it reasons, and can it answer
 * in a JSON schema (single-shot mode). Each check is a real request.
 */

const WEATHER: ToolDefinition = {
  type: "function",
  function: {
    name: "get_weather",
    description: "The current weather in a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"],
    },
  },
};

const PUZZLE =
  "A ferry leaves every 40 minutes from 6:10am. A second ferry leaves every 25 minutes from 6:00am. When do they next leave at the same minute after 6:10am? Answer with the time only.";

export interface ProbeResult {
  model: string;
  reachable: string;
  tools: string;
  reasoning: string;
  json: string;
  suggested: string;
}

function why(err: unknown): string {
  if (err instanceof ModelError) return err.status ? `error ${err.status}${err.code ? ` ${err.code}` : ""}` : "unreachable";
  return err instanceof Error ? err.message.slice(0, 60) : String(err);
}

export async function probeModel(chat: ChatModel, model: string): Promise<ProbeResult> {
  const r: ProbeResult = { model, reachable: "no", tools: "-", reasoning: "-", json: "-", suggested: "don't use" };
  const ask = (messages: ChatMessage[], effort: ReasoningEffort = "low", extra = {}) =>
    chat.complete({ model, messages, reasoningEffort: effort, ...extra });

  const started = Date.now();
  try {
    const res = await ask([{ role: "user", content: "Reply with the single word: ready." }]);
    r.reachable = `yes, ${((Date.now() - started) / 1000).toFixed(1)}s`;
    if (!res.content?.trim()) r.reachable += " (empty reply)";
  } catch (err) {
    r.reachable = `no: ${why(err)}`;
    return r;
  }

  let toolsOk = false;
  try {
    const messages: ChatMessage[] = [
      { role: "user", content: "What's the weather in Portland, Oregon right now? Use the tool, then tell me in one sentence." },
    ];
    const first = await ask(messages, "low", { tools: [WEATHER] });
    const call = first.toolCalls[0];
    if (!call) {
      r.tools = "no tool call";
    } else if (call.function.name !== "get_weather") {
      r.tools = `called ${call.function.name}`;
    } else {
      const args = JSON.parse(call.function.arguments) as { city?: unknown };
      if (typeof args.city !== "string") {
        r.tools = "bad arguments";
      } else {
        messages.push({ role: "assistant", content: first.content, tool_calls: [call] });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ city: args.city, conditions: "fog", temperature_f: 58 }),
        });
        const second = await ask(messages, "low", { tools: [WEATHER] });
        const text = second.content ?? "";
        toolsOk = second.toolCalls.length === 0 && /58|fog/i.test(text);
        r.tools = toolsOk ? "yes" : second.toolCalls.length ? "loops on the tool" : "ignored the result";
      }
    }
  } catch (err) {
    r.tools = `failed: ${why(err)}`;
  }

  try {
    const low = await ask([{ role: "user", content: PUZZLE }], "low");
    const high = await ask([{ role: "user", content: PUZZLE }], "high");
    const a = low.usage.reasoningTokens;
    const b = high.usage.reasoningTokens;
    r.reasoning =
      a === 0 && b === 0
        ? "no reasoning tokens reported"
        : b > a * 1.5
          ? `honored (low ${a}, high ${b})`
          : `unclear (low ${a}, high ${b})`;
  } catch (err) {
    r.reasoning = `failed: ${why(err)}`;
  }

  let jsonOk = false;
  try {
    const res = await ask([{ role: "user", content: "What is 17 + 25? Answer as JSON." }], "low", {
      jsonSchema: {
        name: "sum",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { answer: { type: "integer" } },
          required: ["answer"],
        },
      },
    });
    const parsed = extractJson(res.content ?? "") as { answer?: unknown };
    jsonOk = parsed.answer === 42;
    r.json = jsonOk ? "yes" : "wrong shape";
  } catch (err) {
    r.json = `failed: ${why(err)}`;
  }

  r.suggested = toolsOk ? "tools" : jsonOk ? "single_shot" : "don't use";
  return r;
}

/** Probes each model in turn and prints a table. False if no model was reachable. */
export async function probeModels(chat: ChatModel, models: string[], print: (line: string) => void): Promise<boolean> {
  const results: ProbeResult[] = [];
  for (const model of models) {
    print(`Probing ${model}…`);
    results.push(await probeModel(chat, model));
  }
  const cols: (keyof ProbeResult)[] = ["model", "reachable", "tools", "reasoning", "json", "suggested"];
  const widths = cols.map((c) => Math.max(c.length, ...results.map((r) => r[c].length)));
  const row = (cells: string[]) => `| ${cells.map((c, i) => c.padEnd(widths[i]!)).join(" | ")} |`;
  print("");
  print(row(cols));
  print(`|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`);
  for (const r of results) print(row(cols.map((c) => r[c])));
  return results.some((r) => r.reachable.startsWith("yes"));
}
