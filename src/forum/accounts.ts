import type { Pool, PoolClient } from "pg";
import { DatabaseError } from "pg";
import { withTransaction } from "../db/index.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import type { LoginLimiter } from "../auth/login-limiter.js";
import { randomToken } from "../auth/tokens.js";
import type { ForumContext } from "./context.js";
import { ForumError, forbidden, invalid } from "./errors.js";
import { asAdmin } from "./permissions.js";
import type { Role, Viewer } from "./types.js";
import { validatePassword, validateUsername } from "./validate.js";

const INVITE_CODE_BYTES = 12;

const UNIQUE_VIOLATION = "23505";

/** Creates a member. Shared by registration and the create-admin script. */
export async function insertUser(
  db: Pool | PoolClient,
  opts: { username: string; password: string | null; role?: Role; isBot?: boolean }
): Promise<number> {
  const username = validateUsername(opts.username);
  const passwordHash = opts.password === null ? null : await hashPassword(validatePassword(opts.password));
  try {
    const { rows } = await db.query<{ id: number }>(
      `INSERT INTO users (username, password_hash, role, is_bot)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [username, passwordHash, opts.role ?? "member", opts.isBot ?? false]
    );
    return rows[0]!.id;
  } catch (err) {
    if (err instanceof DatabaseError && err.code === UNIQUE_VIOLATION) {
      throw new ForumError(409, "That username is taken.");
    }
    throw err;
  }
}

/** Checks a username and password; returns the member's id. */
export async function login(
  ctx: ForumContext,
  limiter: LoginLimiter,
  username: string,
  password: string
): Promise<number> {
  if (limiter.isBlocked(username)) {
    throw new ForumError(429, "Too many failed attempts. Try again later.");
  }
  const { rows } = await ctx.pool.query<{ id: number; password_hash: string | null; status: string }>(
    `SELECT id, password_hash, status FROM users
      WHERE LOWER(username) = LOWER($1) AND deleted_at IS NULL`,
    [username.trim()]
  );
  const user = rows[0];
  // Bots have no password and can't log in through the web.
  const ok = user?.password_hash ? await verifyPassword(user.password_hash, password) : false;
  if (!user || !ok) {
    limiter.recordFailure(username);
    throw invalid("That username and password don't match.");
  }
  if (user.status === "banned") throw forbidden("This account is banned.");
  limiter.recordSuccess(username);
  return user.id;
}

export interface InviteStatus {
  code: string;
  note: string;
  createdAt: Date;
  expiresAt: Date | null;
  usedByName: string | null;
  usedAt: Date | null;
  revoked: boolean;
}

export async function createInvite(
  ctx: ForumContext,
  viewer: Viewer | null,
  note: string,
  expiryDays: number | null
): Promise<string> {
  if (!asAdmin(viewer)) throw forbidden();
  const code = randomToken(INVITE_CODE_BYTES);
  await ctx.pool.query(
    `INSERT INTO invites (code, created_by, note, expires_at)
     VALUES ($1, $2, $3, NOW() + $4::float8 * INTERVAL '1 day')`,
    [code, viewer.id, note.trim(), expiryDays]
  );
  return code;
}

export async function listInvites(ctx: ForumContext, viewer: Viewer | null): Promise<InviteStatus[]> {
  if (!asAdmin(viewer)) throw forbidden();
  const { rows } = await ctx.pool.query<{
    code: string;
    note: string;
    created_at: Date;
    expires_at: Date | null;
    used_by_name: string | null;
    used_at: Date | null;
    deleted_at: Date | null;
  }>(
    `SELECT i.code, i.note, i.created_at, i.expires_at, u.username AS used_by_name, i.used_at, i.deleted_at
       FROM invites i LEFT JOIN users u ON u.id = i.used_by
      ORDER BY i.created_at DESC`
  );
  return rows.map((r) => ({
    code: r.code,
    note: r.note,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    usedByName: r.used_by_name,
    usedAt: r.used_at,
    revoked: r.deleted_at !== null,
  }));
}

export async function revokeInvite(ctx: ForumContext, viewer: Viewer | null, code: string): Promise<void> {
  if (!asAdmin(viewer)) throw forbidden();
  await ctx.pool.query(
    "UPDATE invites SET deleted_at = NOW() WHERE code = $1 AND used_at IS NULL AND deleted_at IS NULL",
    [code]
  );
}

/** Registration: spends a single-use invite code on a new member. */
export async function register(
  ctx: ForumContext,
  code: string,
  username: string,
  password: string
): Promise<number> {
  return withTransaction(ctx.pool, async (client) => {
    const { rows } = await client.query<{ usable: boolean }>(
      `SELECT (used_at IS NULL AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())) AS usable
         FROM invites WHERE code = $1 FOR UPDATE`,
      [code.trim()]
    );
    if (!rows[0]?.usable) throw invalid("That invite code isn't valid. It may have been used or expired.");
    const userId = await insertUser(client, { username, password });
    await client.query("UPDATE invites SET used_by = $2, used_at = NOW() WHERE code = $1", [code.trim(), userId]);
    return userId;
  });
}
