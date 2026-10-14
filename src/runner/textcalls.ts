import type { ToolCall } from "./model.js";

/**
 * Tool calls a model wrote out as text instead of calling them. DeepSeek's
 * models sometimes end a visit with their own call markup in the message
 * ("DSML"), so the reply they meant to post was lost:
 *
 *   <｜DSML｜tool_calls>
 *   <｜DSML｜invoke name="reply">
 *   <｜DSML｜parameter name="body" string="true">…</｜DSML｜parameter>
 *   <｜DSML｜parameter name="thread_id" string="false">26</｜DSML｜parameter>
 *   </｜DSML｜invoke>
 *   </｜DSML｜tool_calls>
 *
 * The runner reads them back as the calls they were meant to be. A
 * parameter marked string="false" is JSON (a number, true, a list); one
 * that won't parse is kept as text. The bars may be full-width (｜) or plain.
 */

const BAR = "[｜|]";
const INVOKE = new RegExp(`<${BAR}DSML${BAR}invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)</${BAR}DSML${BAR}invoke>`, "g");
const PARAM = new RegExp(`<${BAR}DSML${BAR}parameter\\s+name="([^"]+)"(?:\\s+string="(true|false)")?\\s*>([\\s\\S]*?)</${BAR}DSML${BAR}parameter>`, "g");
const START = new RegExp(`<${BAR}DSML${BAR}(tool_calls|invoke)\\b`);

export interface TextToolCalls {
  /** What the model wrote before the markup, trimmed: its note, if anything. */
  text: string;
  calls: ToolCall[];
}

/** The calls written out in `content`, or null if there are none. */
export function textToolCalls(content: string | null | undefined, idPrefix = "text"): TextToolCalls | null {
  if (!content) return null;
  const start = content.search(START);
  if (start === -1) return null;
  const calls: ToolCall[] = [];
  for (const inv of content.slice(start).matchAll(INVOKE)) {
    const args: Record<string, unknown> = {};
    for (const p of inv[2]!.matchAll(PARAM)) {
      const raw = p[3]!.trim();
      if (p[2] === "false") {
        try {
          args[p[1]!] = JSON.parse(raw);
          continue;
        } catch {
          // Not JSON after all: keep the text.
        }
      }
      args[p[1]!] = raw;
    }
    calls.push({ id: `${idPrefix}-${calls.length + 1}`, type: "function", function: { name: inv[1]!, arguments: JSON.stringify(args) } });
  }
  return calls.length ? { text: content.slice(0, start).trim(), calls } : null;
}
