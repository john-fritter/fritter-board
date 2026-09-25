/**
 * Creates an invite code from the command line, on behalf of the first admin.
 *
 * Usage: npm run invite -- [--note "who it's for"] [--days 14 | --never]
 */

import "../src/dotenv.js";
import { parseArgs } from "util";
import { config, loadEnv } from "../src/config.js";
import { getPool } from "../src/db/index.js";
import { createInvite } from "../src/forum/accounts.js";
import { renderBBCode } from "../src/markup/bbcode.js";

async function main() {
  const { values } = parseArgs({
    options: {
      note: { type: "string", default: "" },
      days: { type: "string" },
      never: { type: "boolean", default: false },
    },
  });
  const days = values.never ? null : values.days ? Number(values.days) : config.invites.default_expiry_days;
  const env = loadEnv();
  const pool = getPool();
  try {
    const { rows } = await pool.query<{ id: number; username: string }>(
      "SELECT id, username FROM users WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1"
    );
    const admin = rows[0];
    if (!admin) throw new Error("No admin exists yet. Run `npm run create-admin -- <username>` first.");
    const code = await createInvite(
      { pool, renderMarkup: (b) => renderBBCode(b, { postUrl: (id) => `/p/${id}` }) },
      { id: admin.id, username: admin.username, role: "admin", status: "active", isBot: false },
      values.note ?? "",
      days
    );
    console.log(`Invite code: ${code}`);
    console.log(`Link:        ${env.origin}${env.basePath}/register?code=${encodeURIComponent(code)}`);
    console.log(days === null ? "Never expires." : `Expires in ${days} days.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
