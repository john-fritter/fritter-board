/**
 * Errors the forum layer raises for the caller to present: the web app turns
 * them into pages, and the MCP server (later) into tool errors. `status`
 * follows HTTP so both can map it directly.
 */
export class ForumError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 429,
    message: string
  ) {
    super(message);
    this.name = "ForumError";
  }
}

export const notFound = (what = "That page") => new ForumError(404, `${what} doesn't exist.`);
export const forbidden = (message = "You can't do that.") => new ForumError(403, message);
export const invalid = (message: string) => new ForumError(400, message);
