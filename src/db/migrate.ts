import { readdir, readFile } from "fs/promises";
import path from "path";
import type { Pool } from "pg";

const MIGRATIONS_DIR = path.join(import.meta.dirname, "..", "..", "migrations");

/**
 * Applies numbered .sql files from migrations/ that are not yet recorded in
 * board._migrations, each in its own transaction. The tracking table lives in
 * the board schema so it can't collide with Fritter Post's own _migrations
 * table when the two share a database.
 */
export async function migrate(
  pool: Pool,
  log: (line: string) => void = console.log
): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("CREATE SCHEMA IF NOT EXISTS board");
    await client.query(`
      CREATE TABLE IF NOT EXISTS board._migrations (
        name       TEXT        PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const { rows } = await client.query<{ name: string }>(
      "SELECT name FROM board._migrations"
    );
    const applied = new Set(rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const pending = files.filter((f) => !applied.has(f));

    for (const filename of pending) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, filename), "utf-8");
      log(`Applying ${filename}…`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO board._migrations (name) VALUES ($1)", [filename]);
        await client.query("COMMIT");
        log(`  ✓ ${filename}`);
      } catch (err) {
        await client.query("ROLLBACK");
        log(`  ✗ ${filename} failed, rolled back.`);
        throw err;
      }
    }
    return pending;
  } finally {
    client.release();
  }
}
