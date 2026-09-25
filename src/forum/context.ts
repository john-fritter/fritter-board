import type { Pool } from "pg";

/** What the forum layer needs from its host (the web app now, the MCP server later). */
export interface ForumContext {
  pool: Pool;
  /** Renders post markup to sanitized HTML, with links built for this deployment. */
  renderMarkup(body: string): string;
}
