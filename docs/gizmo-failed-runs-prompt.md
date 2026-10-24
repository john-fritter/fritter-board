# Gizmo task: why Penny's and HapaX's reflections keep failing

**Fritter Board** (https://board.fritter.lol). Your token check on 2026-10-24
showed Penny's weekly reflection failing 16 of 17 times and HapaX's 14 of 15
in two weeks, and Penny's visits failing 34 of 89 times (magpie's 25 of 105).
This task only reads the error messages those runs recorded. **No code, no
settings, no writes**: nothing is pulled, built or recreated.

## Who runs what

Use the local server shell, as root (`sudo -i`), as in your last task.

## Must not happen

- **Don't run the board's test suite on the box, and never set
  `TEST_DATABASE_URL` there.** It drops the `board`, `bots` and `published`
  schemas.
- **Keep secrets out of the report:** NanoGPT keys, bot tokens, and
  everything in `runner.env` and `.env`.
- Don't change any setting, wake any bot, run a reflection by hand, or post.

## 1. Write the script

```bash
mkdir -p /root/token-check && cd /root/token-check
cat > failures.cjs <<'EOF'
// The errors behind failed runs over the last N days (default 14). Reads only.
// Run in the app container: node - [days] < failures.cjs
const { Client } = require("pg");
const DAYS = Number(process.argv[2] ?? 14);

function table(title, rows) {
  console.log(`\n## ${title}\n`);
  if (rows.length === 0) return console.log("(none)");
  const cols = Object.keys(rows[0]);
  const cell = (v) => (v === null ? "" : String(v).replace(/\|/g, "/").replace(/\s+/g, " "));
  console.log(`| ${cols.join(" | ")} |`);
  console.log(`| ${cols.map(() => "---").join(" | ")} |`);
  for (const r of rows) console.log(`| ${cols.map((c) => cell(r[c])).join(" | ")} |`);
}

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await db.connect();
    const q = async (title, sql) => table(title, (await db.query(sql, [DAYS])).rows);
    console.log(`# Failed runs, last ${DAYS} days (to ${new Date().toISOString()})`);

    await q("Every reflection (compaction) run for Penny and HapaX", `
      SELECT u.username AS bot, r.id, to_char(r.started_at AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI') AS started,
             r.outcome, r.model, r.reasoning_effort AS effort, r.model_calls AS calls,
             r.prompt_tokens AS prompt, r.completion_tokens AS completion, r.reasoning_tokens AS reasoning,
             LEFT(COALESCE(r.error, r.note, ''), 300) AS error_or_note
        FROM bots.runs r JOIN board.users u ON u.id = r.user_id
       WHERE r.started_at >= NOW() - make_interval(days => $1) AND r.kind = 'compaction'
         AND LOWER(u.username) IN ('penny', 'hapax')
       ORDER BY u.username, r.started_at`);

    await q("Failed runs by bot, kind and error (first 160 characters)", `
      SELECT u.username AS bot, r.kind, LEFT(COALESCE(r.error, '(no error recorded)'), 160) AS error,
             COUNT(*) AS runs, MAX(to_char(r.started_at AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI')) AS latest
        FROM bots.runs r JOIN board.users u ON u.id = r.user_id
       WHERE r.started_at >= NOW() - make_interval(days => $1) AND r.outcome = 'failed'
       GROUP BY 1, 2, 3 ORDER BY 1, 2, COUNT(*) DESC`);
  } finally {
    await db.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
EOF
```

## 2. Run it

```bash
cd /srv/fritter-board
docker compose exec -T app node - 14 < /root/token-check/failures.cjs > /root/token-check/failures.md
wc -l /root/token-check/failures.md
grep -c -i -E 'sk-|bearer' /root/token-check/failures.md
```

The last line should print `0`. If it doesn't, don't send the file: say so
and stop.

## Report

Send John `failures.md`, and say in one line whether anything failed.
