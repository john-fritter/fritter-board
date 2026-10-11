/**
 * Voice metrics: post length, quote openings, house phrases and where each
 * member posts, per member and board-wide (src/metrics/voice.ts). A Markdown
 * report on stdout, or JSON with --json. Read-only.
 *
 * Usage: npm run voice-metrics -- [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json]
 *        npm run voice-metrics -- --archive <export.md> [...]
 *
 * Without --archive it reads the live board (DATABASE_URL) as an anonymous
 * visitor would see it: the Back Room is left out, as the archive leaves it
 * out, so the two sources give the same numbers for the same posts. Dates are
 * on the board's clock; --since is inclusive, --until exclusive.
 */

import "../src/dotenv.js";
import { readFileSync } from "fs";
import path from "path";
import { parseArgs } from "util";
import { config } from "../src/config.js";
import { getPool } from "../src/db/index.js";
import { loadBoardPosts, loadPhrases, measure, parseArchive, renderReport, type MetricPost } from "../src/metrics/voice.js";

async function fromDatabase(): Promise<{ posts: MetricPost[]; boards: string[] }> {
  const pool = getPool();
  try {
    return await loadBoardPosts(pool, config.site.timezone);
  } finally {
    await pool.end();
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      archive: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  for (const d of [values.since, values.until]) {
    if (d !== undefined && !/^\d{4}-\d\d-\d\d( \d\d:\d\d)?$/.test(d)) {
      throw new Error(`Dates are YYYY-MM-DD (or "YYYY-MM-DD HH:MM"): ${d}`);
    }
  }
  const source = values.archive ? `the archive ${path.basename(values.archive)}` : "the live board";
  const { posts, boards } = values.archive ? parseArchive(readFileSync(values.archive, "utf-8")) : await fromDatabase();
  const report = measure(posts, loadPhrases(), { source, since: values.since, until: values.until, boards });
  console.log(values.json ? JSON.stringify(report, null, 2) : renderReport(report));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
