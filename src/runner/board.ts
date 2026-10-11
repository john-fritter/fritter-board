import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * The runner's connection to the board: an MCP client acting as one bot, with
 * the bot's own token. This is the runner's only way onto the board; it never
 * imports src/forum/ or src/mcp/, and its database role can't see the board
 * schema.
 */

export interface BoardTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  /** What the tool returned: compact JSON on success, a message on failure. */
  text: string;
}

export interface BoardSession {
  /** The server's instructions (house style, BBCode, the Back Room rule). */
  instructions: string;
  tools: BoardTool[];
  call(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

/**
 * `lookOnly`: a dry visit's connection. The MCP server then writes nothing
 * for it: no posts or messages, and nothing marked read or seen.
 */
export type ConnectBoard = (token: string, opts?: { lookOnly?: boolean }) => Promise<BoardSession>;

/** The header that makes an MCP connection look-only (src/mcp/app.ts). */
export const LOOK_ONLY_HEADER = "X-Board-Look-Only";

/** How the server refuses a write on a look-only connection (src/mcp/server.ts says the same). */
export const LOOK_ONLY_REFUSAL = "This connection only looks";

/** Connects over streamable HTTP. `fetchImpl` lets tests reach an in-process server. */
export function httpBoard(url: string, fetchImpl?: typeof fetch): ConnectBoard {
  return async (token, opts = {}) => {
    const client = new Client({ name: "fritter-board-runner", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}`, ...(opts.lookOnly ? { [LOOK_ONLY_HEADER]: "1" } : {}) } },
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      })
    );
    const { tools } = await client.listTools();
    return {
      instructions: client.getInstructions() ?? "",
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema as Record<string, unknown>,
      })),
      async call(name, args) {
        const res = await client.callTool({ name, arguments: args });
        const content = (res.content ?? []) as { type: string; text?: string }[];
        const text = content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
        return { ok: res.isError !== true, text };
      },
      close: () => client.close(),
    };
  };
}

/** Calls a tool the runner itself needs to succeed, and parses its JSON. */
export async function callJson<T>(board: BoardSession, name: string, args: Record<string, unknown>): Promise<T> {
  const res = await board.call(name, args);
  if (!res.ok) throw new Error(`${name}: ${res.text}`);
  return JSON.parse(res.text) as T;
}

/** The fields of get_inbox the runner reads itself. */
export interface InboxPostItem {
  post_id: number;
  thread_id: number;
  thread: string;
  board: string;
  author: string;
  at: string;
  quotes_you?: boolean;
  mentions_you?: boolean;
}

export interface InboxJson {
  since: string;
  now: string;
  you: {
    name: string;
    status?: string;
    writes_left: { this_hour: number; today: number };
  };
  unread_pms: {
    conversation_id: number;
    with: string[];
    unread: number;
    last_at: string;
    /** The newest unread messages, oldest first. */
    messages?: { from: string; at: string; body: string }[];
  }[];
  replies: InboxPostItem[];
  mentions: InboxPostItem[];
  active_threads: { thread_id: number; title: string; board: string; new_posts: number; fp_article_id?: number }[];
  new_articles: string | { fp_article_id: number; title: string; thread_id: number | null }[];
  new_members?: { name: string; bot?: boolean; joined: string }[];
  /** Moderators only. */
  open_reports?: { report_id: number; post_id: number; thread_id: number; at: string }[];
  hot_threads?: { thread_id: number; title: string; board: string; last_at: string }[];
}
