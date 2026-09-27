import { config } from "../config.js";
import type { Db } from "../db/index.js";
import { ForumError } from "../forum/errors.js";
import type { Viewer } from "../forum/types.js";

/**
 * The MCP server's hard cap on how much a bot writes, so a runaway loop can't
 * flood the board whatever the runner does. It's a property of the bot
 * interface, not of membership: the web has no such cap, and nothing in
 * src/forum/ knows about it.
 *
 * Usage is counted from the rows a member has written (posts, messages, edits
 * and reports) over the last rolling hour and day, so there's no counter to
 * drift, and a removed post still counts. Moderation actions aren't capped.
 */

export interface WriteBudget {
  perHour: number;
  perDay: number;
  usedHour: number;
  usedDay: number;
}

export async function writeBudget(db: Db, viewer: Viewer): Promise<WriteBudget> {
  const { rows } = await db.query<{
    per_hour: number | null;
    per_day: number | null;
    used_hour: number;
    used_day: number;
  }>(
    `WITH w AS (
       SELECT created_at AS at FROM posts WHERE author_id = $1 AND created_at > NOW() - INTERVAL '1 day'
       UNION ALL
       SELECT created_at FROM pm_messages WHERE author_id = $1 AND created_at > NOW() - INTERVAL '1 day'
       UNION ALL
       SELECT edited_at FROM post_edits WHERE editor_id = $1 AND edited_at > NOW() - INTERVAL '1 day'
       UNION ALL
       SELECT created_at FROM reports WHERE reporter_id = $1 AND created_at > NOW() - INTERVAL '1 day')
     SELECT (SELECT writes_per_hour FROM bot_limits WHERE user_id = $1) AS per_hour,
            (SELECT writes_per_day FROM bot_limits WHERE user_id = $1) AS per_day,
            (SELECT COUNT(*)::int FROM w WHERE at > NOW() - INTERVAL '1 hour') AS used_hour,
            (SELECT COUNT(*)::int FROM w) AS used_day`,
    [viewer.id]
  );
  const r = rows[0]!;
  return {
    perHour: r.per_hour ?? config.mcp.writes_per_hour,
    perDay: r.per_day ?? config.mcp.writes_per_day,
    usedHour: r.used_hour,
    usedDay: r.used_day,
  };
}

// One write at a time per member, so parallel tool calls can't all pass the
// check before any of them lands. Per process, which is enough: the cap is a
// ceiling for a runaway loop, not an exact quota.
const inFlight = new Map<number, Promise<unknown>>();

/** Runs a write if the member has budget left; otherwise refuses with a 429. */
export async function withinBudget<T>(db: Db, viewer: Viewer, write: () => Promise<T>): Promise<T> {
  const previous = inFlight.get(viewer.id) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    const b = await writeBudget(db, viewer);
    if (b.usedHour >= b.perHour) {
      throw new ForumError(429, `You've reached your limit of ${b.perHour} posts and messages an hour. Try again later.`);
    }
    if (b.usedDay >= b.perDay) {
      throw new ForumError(429, `You've reached your limit of ${b.perDay} posts and messages a day. Try again tomorrow.`);
    }
    return write();
  });
  inFlight.set(viewer.id, run);
  try {
    return await run;
  } finally {
    if (inFlight.get(viewer.id) === run) inFlight.delete(viewer.id);
  }
}
