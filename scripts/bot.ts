/**
 * Bot accounts and their MCP tokens.
 *
 * Usage:
 *   npm run bot -- create <username> [--moderator]   a new bot member, and its token
 *   npm run bot -- token <username>                  a new token (the old one stops working)
 *   npm run bot -- revoke <username>                 no token at all
 *   npm run bot -- limits <username> [--hour N] [--day N] [--default]
 *   npm run bot -- list
 *
 * A token is printed once and never stored in the clear; losing it means
 * issuing a new one. Tokens are for bot accounts only: people log in.
 */

import "../src/dotenv.js";
import { parseArgs } from "util";
import { issueBotToken, revokeBotTokens } from "../src/auth/bot-tokens.js";
import { config } from "../src/config.js";
import { getPool, withTransaction } from "../src/db/index.js";
import { insertUser } from "../src/forum/accounts.js";

const USAGE = `Usage:
  npm run bot -- create <username> [--moderator]
  npm run bot -- token <username>
  npm run bot -- revoke <username>
  npm run bot -- limits <username> [--hour N] [--day N] [--default]
  npm run bot -- list`;

function fail(message: string): never {
  throw new Error(message);
}

function count(raw: string | undefined, what: string): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) fail(`--${what} takes a whole number.`);
  return Number(raw);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      moderator: { type: "boolean", default: false },
      hour: { type: "string" },
      day: { type: "string" },
      default: { type: "boolean", default: false },
    },
  });
  const [command, username] = positionals;
  if (!command || (command !== "list" && !username)) fail(USAGE);

  const pool = getPool();
  const findBot = async (name: string) => {
    const { rows } = await pool.query<{ id: number; username: string; is_bot: boolean }>(
      "SELECT id, username, is_bot FROM users WHERE LOWER(username) = LOWER($1) AND deleted_at IS NULL",
      [name.trim()]
    );
    const user = rows[0] ?? fail(`There's no member called ${name}.`);
    if (!user.is_bot) fail(`${user.username} isn't a bot. Tokens are for bot accounts; people log in.`);
    return user;
  };
  const printToken = (name: string, token: string) => {
    console.log(`Token for ${name} (shown once; store it now):\n\n  ${token}\n`);
    console.log("Pass it as `Authorization: Bearer <token>` over HTTP, or FRITTER_BOARD_TOKEN over stdio.");
  };

  try {
    switch (command) {
      case "create": {
        const { id, token } = await withTransaction(pool, async (client) => {
          const id = await insertUser(client, {
            username: username!,
            password: null,
            isBot: true,
            role: values.moderator ? "moderator" : "member",
          });
          return { id, token: await issueBotToken(client, id) };
        });
        console.log(`Created bot ${username} (id ${id}${values.moderator ? ", moderator" : ""}).`);
        printToken(username!, token);
        break;
      }
      case "token": {
        const bot = await findBot(username!);
        const token = await withTransaction(pool, (client) => issueBotToken(client, bot.id));
        printToken(bot.username, token);
        break;
      }
      case "revoke": {
        const bot = await findBot(username!);
        const n = await revokeBotTokens(pool, bot.id);
        console.log(n > 0 ? `Revoked ${bot.username}'s token.` : `${bot.username} had no live token.`);
        break;
      }
      case "limits": {
        const bot = await findBot(username!);
        if (values.default) {
          await pool.query("DELETE FROM bot_limits WHERE user_id = $1", [bot.id]);
        } else {
          const hour = count(values.hour, "hour");
          const day = count(values.day, "day");
          if (hour !== undefined || day !== undefined) {
            await pool.query(
              `INSERT INTO bot_limits (user_id, writes_per_hour, writes_per_day) VALUES ($1, $2, $3)
               ON CONFLICT (user_id) DO UPDATE
                 SET writes_per_hour = COALESCE($2, bot_limits.writes_per_hour),
                     writes_per_day = COALESCE($3, bot_limits.writes_per_day),
                     updated_at = NOW()`,
              [bot.id, hour ?? null, day ?? null]
            );
          }
        }
        const { rows } = await pool.query<{ writes_per_hour: number | null; writes_per_day: number | null }>(
          "SELECT writes_per_hour, writes_per_day FROM bot_limits WHERE user_id = $1",
          [bot.id]
        );
        const perHour = rows[0]?.writes_per_hour ?? `${config.mcp.writes_per_hour} (default)`;
        const perDay = rows[0]?.writes_per_day ?? `${config.mcp.writes_per_day} (default)`;
        console.log(`${bot.username} may write ${perHour} an hour and ${perDay} a day.`);
        break;
      }
      case "list": {
        const { rows } = await pool.query<{
          username: string;
          role: string;
          status: string;
          has_token: boolean;
          last_used_at: Date | null;
          writes_per_hour: number | null;
          writes_per_day: number | null;
        }>(
          `SELECT u.username, u.role, u.status,
                  EXISTS (SELECT 1 FROM bot_tokens k WHERE k.user_id = u.id AND k.revoked_at IS NULL) AS has_token,
                  (SELECT MAX(k.last_used_at) FROM bot_tokens k WHERE k.user_id = u.id) AS last_used_at,
                  l.writes_per_hour, l.writes_per_day
             FROM users u LEFT JOIN bot_limits l ON l.user_id = u.id
            WHERE u.is_bot AND u.deleted_at IS NULL
            ORDER BY u.id`
        );
        if (rows.length === 0) console.log("No bots yet. npm run bot -- create <username>");
        for (const r of rows) {
          const standing = [r.role !== "member" ? r.role : null, r.status !== "active" ? r.status : null].filter(Boolean);
          console.log(
            [
              r.username + (standing.length ? ` (${standing.join(", ")})` : ""),
              r.has_token ? "token live" : "no token",
              `last used ${r.last_used_at?.toISOString() ?? "never"}`,
              `${r.writes_per_hour ?? config.mcp.writes_per_hour}/hour, ${r.writes_per_day ?? config.mcp.writes_per_day}/day`,
            ].join("  ·  ")
          );
        }
        break;
      }
      default:
        fail(USAGE);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
