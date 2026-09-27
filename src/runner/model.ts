import { config } from "../config.js";

/**
 * The runner's view of a chat model: OpenAI-style chat completions with
 * function calling, as NanoGPT serves them. The runner depends on this
 * interface, so tests can script a model without a network.
 */

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolDefinition {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  reasoningEffort: ReasoningEffort;
  tools?: ToolDefinition[];
  /** A JSON schema the reply must match (single-shot mode). */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  signal?: AbortSignal;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
}

export interface ChatResponse {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: Usage;
}

export interface ChatModel {
  complete(req: ChatRequest): Promise<ChatResponse>;
}

/** A model call that failed. `code` is NanoGPT's error code when it gave one. */
export class ModelError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
    readonly retryAfterSeconds: number | null
  ) {
    super(message);
    this.name = "ModelError";
  }

  /** The key's requests-per-day (or dollars-per-day) cap: nothing to do until it resets. */
  get isDailyCap(): boolean {
    return this.status === 429 && (this.code === "daily_rpd_limit_exceeded" || this.code === "daily_usd_limit_exceeded");
  }

  /** Worth one retry: rate limiting other than the daily cap, server errors, timeouts, network. */
  get isTransient(): boolean {
    if (this.isDailyCap) return false;
    return this.status === null || this.status === 429 || this.status >= 500;
  }
}

/**
 * Model ids with these suffixes turn on paid extras (web search, memory) or
 * provider routing, which NanoGPT bills pay-as-you-go even on a subscription.
 */
const PAID_SUFFIX = /:(online|memory|fast|cheap|caching|cache|cached)\b/i;

export function modelIdProblem(model: string): string | null {
  if (!model.trim()) return "A model id is required.";
  if (/\s/.test(model)) return "Model ids have no spaces.";
  if (PAID_SUFFIX.test(model)) return `${model} carries a suffix that bills outside the subscription; use the plain model id.`;
  return null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Reads token counts from whichever of NanoGPT's usage fields are present. */
export function parseUsage(raw: unknown): Usage {
  const u = (raw ?? {}) as Record<string, unknown>;
  const completionDetails = (u["completion_tokens_details"] ?? {}) as Record<string, unknown>;
  const promptDetails = (u["prompt_tokens_details"] ?? {}) as Record<string, unknown>;
  return {
    promptTokens: num(u["prompt_tokens"]),
    completionTokens: num(u["completion_tokens"]),
    reasoningTokens: num(u["reasoning_tokens"]) || num(completionDetails["reasoning_tokens"]),
    cachedTokens: num(promptDetails["cached_tokens"]) || num(u["cache_read_input_tokens"]),
  };
}

/**
 * NanoGPT's chat completions, on the subscription base URL. The runner never
 * sends provider selection or billing overrides: those bypass the
 * subscription and bill pay-as-you-go.
 */
export class NanoGptModel implements ChatModel {
  constructor(
    private readonly apiKey: string,
    private readonly opts: { baseUrl?: string; fetch?: typeof fetch; timeoutSeconds?: number } = {}
  ) {}

  async complete(req: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream: false,
      include_usage: true,
      max_tokens: config.runner.max_output_tokens,
      reasoning_effort: req.reasoningEffort,
      // Reasoning is still billed; this only keeps its text out of the reply.
      reasoning: { exclude: true },
    };
    if (req.tools && req.tools.length > 0) {
      body["tools"] = req.tools;
      body["tool_choice"] = "auto";
      body["parallel_tool_calls"] = false;
    }
    if (req.jsonSchema) {
      body["response_format"] = {
        type: "json_schema",
        json_schema: { name: req.jsonSchema.name, strict: true, schema: req.jsonSchema.schema },
      };
    }

    const timeout = AbortSignal.timeout((this.opts.timeoutSeconds ?? config.runner.model_timeout_seconds) * 1000);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const url = `${(this.opts.baseUrl ?? config.runner.nanogpt_base_url).replace(/\/+$/, "")}/chat/completions`;
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      const what = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "couldn't be reached";
      throw new ModelError(`The model ${what}: ${err instanceof Error ? err.message : String(err)}`, null, null, null);
    }

    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const e = (json?.["error"] ?? {}) as Record<string, unknown>;
      const message =
        (typeof e["message"] === "string" && e["message"]) ||
        (typeof json?.["message"] === "string" && json["message"]) ||
        text.slice(0, 300) ||
        res.statusText;
      const retryAfter = Number(res.headers.get("retry-after"));
      throw new ModelError(
        `NanoGPT ${res.status}: ${message}`,
        res.status,
        typeof e["code"] === "string" ? e["code"] : null,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null
      );
    }
    if (!json) throw new ModelError("NanoGPT sent something that isn't JSON.", res.status, null, null);

    const choice = ((json["choices"] as unknown[] | undefined) ?? [])[0] as Record<string, unknown> | undefined;
    const message = (choice?.["message"] ?? {}) as Record<string, unknown>;
    const rawCalls = Array.isArray(message["tool_calls"]) ? (message["tool_calls"] as Record<string, unknown>[]) : [];
    const toolCalls: ToolCall[] = rawCalls.map((c, i) => {
      const fn = (c["function"] ?? {}) as Record<string, unknown>;
      const args = fn["arguments"];
      return {
        id: typeof c["id"] === "string" && c["id"] ? c["id"] : `call_${i}`,
        type: "function",
        function: {
          name: typeof fn["name"] === "string" ? fn["name"] : "",
          arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
        },
      };
    });
    return {
      content: typeof message["content"] === "string" ? message["content"] : null,
      toolCalls,
      finishReason: typeof choice?.["finish_reason"] === "string" ? choice["finish_reason"] : null,
      usage: parseUsage(json["usage"]),
    };
  }
}
