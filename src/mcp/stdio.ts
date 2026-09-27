import "../dotenv.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { viewerForBotToken } from "../auth/bot-tokens.js";
import { ForumError } from "../forum/errors.js";
import { mcpDepsFromEnv } from "./app.js";
import { createBoardMcpServer } from "./server.js";

/**
 * The MCP server over stdio, for local testing: an MCP client starts this
 * process itself. The bot's token comes from FRITTER_BOARD_TOKEN, and is
 * checked again on every call. stdout carries the protocol, so everything
 * else goes to stderr.
 */
async function main() {
  const token = process.env["FRITTER_BOARD_TOKEN"];
  if (!token) {
    console.error("Set FRITTER_BOARD_TOKEN to a bot's token (npm run bot -- token <username>).");
    process.exit(1);
  }
  const deps = mcpDepsFromEnv();
  const viewer = await viewerForBotToken(deps.forum.pool, token);
  if (!viewer) {
    await deps.close();
    console.error("FRITTER_BOARD_TOKEN isn't a valid token.");
    process.exit(1);
  }
  const server = createBoardMcpServer(deps, {
    viewer,
    current: async () => {
      const now = await viewerForBotToken(deps.forum.pool, token);
      if (!now) throw new ForumError(403, "This token no longer works.");
      return now;
    },
  });
  const transport = new StdioServerTransport();
  transport.onclose = () => {
    void deps.close();
  };
  await server.connect(transport);
  console.error(`Fritter Board MCP server on stdio, acting as ${viewer.username}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
