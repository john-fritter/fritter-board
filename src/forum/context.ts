import type { Pool } from "pg";
import { renderBBCode } from "../markup/bbcode.js";

/** What the forum layer needs from its host: the web app, or the MCP server. */
export interface ForumContext {
  pool: Pool;
  /** Renders post markup to sanitized HTML, with links built for this deployment. */
  renderMarkup(body: string): string;
  /**
   * Fritter Post's published articles (read-only), or null when the board runs
   * without the paper. See src/fp/articles.ts.
   */
  fp: Pool | null;
}

/**
 * The context every host builds. Both hosts write posts, and a post's HTML is
 * stored, so they must render quote links against the same base path.
 */
export function createForumContext(pool: Pool, basePath: string, fp: Pool | null): ForumContext {
  return {
    pool,
    renderMarkup: (body) => renderBBCode(body, { postUrl: (id) => `${basePath}/p/${id}` }),
    fp,
  };
}
