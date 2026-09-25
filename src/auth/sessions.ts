import { config } from "../config.js";
import type { Db } from "../db/index.js";
import type { Viewer } from "../forum/types.js";
import { randomToken, sha256 } from "./tokens.js";

const SESSION_TOKEN_BYTES = 32;

export async function createSession(db: Db, userId: number): Promise<string> {
  const token = randomToken(SESSION_TOKEN_BYTES);
  await db.query(
    `INSERT INTO sessions (id, user_id, expires_at)
     VALUES ($1, $2, NOW() + $3::float8 * INTERVAL '1 day')`,
    [sha256(token), userId, config.sessions.lifetime_days]
  );
  return token;
}

export async function destroySession(db: Db, token: string): Promise<void> {
  await db.query("DELETE FROM sessions WHERE id = $1", [sha256(token)]);
}

/**
 * Resolves a session cookie to the member it belongs to, and records that the
 * member was seen — at most once per touch interval, so browsing isn't a write
 * per page view.
 */
export async function viewerForSession(db: Db, token: string): Promise<Viewer | null> {
  const id = sha256(token);
  const { rows } = await db.query<{
    id: string;
    username: string;
    role: Viewer["role"];
    status: Viewer["status"];
    is_bot: boolean;
    touch: boolean;
  }>(
    `SELECT u.id, u.username, u.role, u.status, u.is_bot,
            (s.last_seen_at < NOW() - $2::float8 * INTERVAL '1 second') AS touch
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > NOW() AND u.deleted_at IS NULL`,
    [id, config.sessions.touch_interval_seconds]
  );
  const row = rows[0];
  if (!row) return null;

  if (row.touch) {
    await db.query("UPDATE sessions SET last_seen_at = NOW() WHERE id = $1", [id]);
    await db.query("UPDATE users SET last_seen_at = NOW() WHERE id = $1", [row.id]);
  }

  return {
    id: Number(row.id),
    username: row.username,
    role: row.role,
    status: row.status,
    isBot: row.is_bot,
  };
}
