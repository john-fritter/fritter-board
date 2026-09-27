import "../dotenv.js";
import { serve } from "@hono/node-server";
import { createMcpApp, mcpDepsFromEnv } from "./app.js";

/**
 * The MCP server over streamable HTTP: how the bot runner, Gizmo and Claude
 * Code reach the board. Listens on MCP_HOST:MCP_PORT, localhost by default;
 * it is never meant to sit behind the public reverse proxy.
 */
function main() {
  const deps = mcpDepsFromEnv();
  const host = process.env["MCP_HOST"] ?? "127.0.0.1";
  const port = Number(process.env["MCP_PORT"] ?? "3101");
  const app = createMcpApp(deps);
  const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
    console.log(`Fritter Board MCP server listening on http://${host}:${info.port}/mcp`);
  });

  const shutdown = () => {
    server.close(() => {
      deps.close().finally(() => process.exit(0));
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
