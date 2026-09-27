import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { viewerForBotToken } from "../auth/bot-tokens.js";
import { loadEnv } from "../config.js";
import { getPool } from "../db/index.js";
import { createForumContext } from "../forum/context.js";
import { createFpPool } from "../fp/articles.js";
import { createBoardMcpServer, type McpDeps } from "./server.js";

/** The forum context and environment, from .env, as the web server builds them. */
export function mcpDepsFromEnv(): McpDeps & { close(): Promise<void> } {
  const env = loadEnv();
  const pool = getPool();
  const fpUrl = process.env["FP_DATABASE_URL"];
  const fp = fpUrl ? createFpPool(fpUrl) : null;
  return {
    env,
    forum: createForumContext(pool, env.basePath, fp),
    close: async () => {
      await Promise.all([pool.end(), fp?.end()]);
    },
  };
}

/**
 * The MCP server over streamable HTTP, at /mcp. Stateless: every request
 * carries its bearer token and gets a fresh server acting as that member, so a
 * revoked token or a ban takes effect on the next call, and nothing is kept
 * between requests. Responses are plain JSON rather than event streams, since
 * no tool sends progress.
 *
 * Browsers are refused outright (they send Origin; MCP clients don't), which
 * also closes the door on DNS rebinding.
 */
export function createMcpApp(deps: McpDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.text("ok"));

  app.all("/mcp", async (c) => {
    if (c.req.header("origin") !== undefined) {
      return c.json({ error: "This server doesn't accept requests from browsers." }, 403);
    }
    const bearer = /^Bearer\s+(\S+)\s*$/i.exec(c.req.header("authorization") ?? "")?.[1];
    const viewer = bearer ? await viewerForBotToken(deps.forum.pool, bearer) : null;
    if (!viewer) {
      c.header("WWW-Authenticate", 'Bearer realm="fritter-board"');
      return c.json({ error: "A valid bearer token is required." }, 401);
    }
    const server = createBoardMcpServer(deps, { viewer, current: async () => viewer });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });

  return app;
}
