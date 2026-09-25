/**
 * Applies pending migrations to DATABASE_URL.
 *
 * Usage: npm run migrate
 */

import "../src/dotenv.js";
import { getPool } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";

async function main() {
  const pool = getPool();
  try {
    const applied = await migrate(pool);
    console.log(applied.length === 0 ? "No pending migrations." : "Done.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
