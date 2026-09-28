import { config } from "../config.js";
import type { Db } from "../db/index.js";
import type { Viewer } from "../forum/types.js";
import { randomToken, sha256 } from "./tokens.js";

/**
 * Bearer tokens: how a bot proves who it is to the MCP server. Each token maps
 * to one users row, and the server then acts as that member, under the same
 * checks as the web app. Only the SHA-256 is stored, as with sessions.
 */

const TOKEN_BYTES = 32;
/** Tokens carry a recognizable prefix, so one pasted into the wrong place is easy to spot. */
const TOKEN_PREFIX = "fb_";

/** Issues a new token for a member, revoking any they already had. Returns the token itself, once. */
export async function issueBotToken(db: Db, userId: number): Promise<string> {
  const token = TOKEN_PREFIX + randomToken(TOKEN_BYTES);
  await db.query("UPDATE bot_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
  await db.query("INSERT INTO bot_tokens (user_id, token_hash) VALUES ($1, $2)", [userId, sha256(token)]);
  return token;
}

/** Revokes a member's tokens. Returns how many were live. */
export async function revokeBotTokens(db: Db, userId: number): Promise<number> {
  const { rowCount } = await db.query(
    "UPDATE bot_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL",
    [userId]
  );
  return rowCount ?? 0;
}

/**
 * Resolves a bearer token to the member it acts as, or null. A banned or
 * deleted member's token stops working at once, as a banned member's login
 * does; a suspended one still reads, like on the web. The token's own
 * last_used_at is recorded at most once per touch interval.
 *
 * Resolving a token doesn't count as being seen: calling a tool does
 * (markBotSeen), so a runner peeking at a bot's inbox every few minutes doesn't
 * keep the bot in Who's online.
 */
export async function viewerForBotToken(db: Db, token: string): Promise<Viewer | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const hash = sha256(token);
  const { rows } = await db.query<{
    id: number;
    username: string;
    role: Viewer["role"];
    status: Viewer["status"];
    is_bot: boolean;
    touch: boolean;
  }>(
    `SELECT u.id, u.username, u.role, u.status, u.is_bot,
            (k.last_used_at IS NULL OR k.last_used_at < NOW() - $2::float8 * INTERVAL '1 second') AS touch
       FROM bot_tokens k
       JOIN users u ON u.id = k.user_id
      WHERE k.token_hash = $1 AND k.revoked_at IS NULL
        AND u.deleted_at IS NULL AND u.status <> 'banned'`,
    [hash, config.sessions.touch_interval_seconds]
  );
  const row = rows[0];
  if (!row) return null;
  if (row.touch) {
    await db.query("UPDATE bot_tokens SET last_used_at = NOW() WHERE token_hash = $1", [hash]);
  }
  return { id: row.id, username: row.username, role: row.role, status: row.status, isBot: row.is_bot };
}

/**
 * Records that a bot was active, so it shows in Who's online as a member
 * reading the board does. At most one write per touch interval.
 */
export async function markBotSeen(db: Db, userId: number): Promise<void> {
  await db.query(
    `UPDATE users SET last_seen_at = NOW()
      WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < NOW() - $2::float8 * INTERVAL '1 second')`,
    [userId, config.sessions.touch_interval_seconds]
  );
}
