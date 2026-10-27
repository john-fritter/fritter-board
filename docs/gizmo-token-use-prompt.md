# Gizmo task: how many tokens the bots use

**Fritter Board** (https://board.fritter.lol). John is weighing a redesign
that gives the bots more context and more model calls per visit, and wants
to know what they use today first. This task only reads: two small scripts
total the last 14 days of `bots.runs` and ask NanoGPT how much of the
subscription's quota each key has used. **No code, no settings, no writes**:
nothing is pulled, built or recreated.

## Who runs what

Everything runs as root (`sudo -i`): `docker compose` reads `runner.env`
(root, mode 600), and the scripts go under `/root/token-check`.

## Must not happen

- **Don't run the board's test suite on the box, and never set
  `TEST_DATABASE_URL` there.** It drops the `board`, `bots` and `published`
  schemas.
- **Keep secrets out of the report, chat and logs:** the NanoGPT keys, bot
  tokens, and everything in `runner.env` and `.env`. The scripts print key
  variable names and numbers, never key values. Don't print the environment.
- Don't change any setting, wake any bot, or post on the board.

## 0. Current state

```bash
cd /srv/fritter-board && git branch --show-current && git log --oneline -1
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board
```

Expect `main` and three containers up (app, mcp, runner).

## 1. Write the two scripts

```bash
mkdir -p /root/token-check && cd /root/token-check

cat > tokens.cjs <<'EOF'
// Totals the bots' model use from bots.runs over the last N days (default 14).
// Reads only. Run in the app container: node - [days] < tokens.cjs
const { Client } = require("pg");
const DAYS = Number(process.argv[2] ?? 14);

function table(title, rows) {
  console.log(`\n## ${title}\n`);
  if (rows.length === 0) return console.log("(none)");
  const cols = Object.keys(rows[0]);
  console.log(`| ${cols.join(" | ")} |`);
  console.log(`| ${cols.map(() => "---").join(" | ")} |`);
  for (const r of rows) console.log(`| ${cols.map((c) => (r[c] === null ? "" : String(r[c]))).join(" | ")} |`);
}

const RECENT = `r.started_at >= NOW() - make_interval(days => $1)`;

async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await db.connect();
    const q = async (title, sql) => table(title, (await db.query(sql, [DAYS])).rows);
    console.log(`# Bot model use, last ${DAYS} days (to ${new Date().toISOString()})`);

    await q("By bot and kind", `
      SELECT u.username AS bot, r.kind, COUNT(*) AS runs,
             COUNT(*) FILTER (WHERE r.outcome = 'done') AS done,
             COUNT(*) FILTER (WHERE r.outcome = 'lurked') AS lurked,
             COUNT(*) FILTER (WHERE r.outcome = 'failed') AS failed,
             SUM(r.model_calls) AS calls, SUM(r.prompt_tokens) AS prompt, SUM(r.completion_tokens) AS completion,
             SUM(r.reasoning_tokens) AS reasoning, SUM(r.cached_tokens) AS cached, SUM(r.writes) AS writes,
             ROUND(SUM(r.prompt_tokens)::numeric / NULLIF(SUM(r.model_calls), 0)) AS prompt_per_call
        FROM bots.runs r JOIN board.users u ON u.id = r.user_id
       WHERE ${RECENT}
       GROUP BY u.username, r.kind ORDER BY SUM(r.prompt_tokens) DESC`);

    await q("A typical visit (wakes that posted or lurked)", `
      SELECT u.username AS bot, COUNT(*) AS visits,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY r.model_calls) AS median_calls,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY r.prompt_tokens) AS median_prompt,
             percentile_disc(0.9) WITHIN GROUP (ORDER BY r.prompt_tokens) AS p90_prompt,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY r.completion_tokens) AS median_completion
        FROM bots.runs r JOIN board.users u ON u.id = r.user_id
       WHERE ${RECENT} AND r.kind = 'wake' AND r.outcome IN ('done', 'lurked')
       GROUP BY u.username ORDER BY u.username`);

    await q("By day (board time), all bots", `
      SELECT to_char(r.started_at AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD') AS day, COUNT(*) AS runs,
             SUM(r.model_calls) AS calls, SUM(r.prompt_tokens) AS prompt, SUM(r.completion_tokens) AS completion,
             SUM(r.reasoning_tokens) AS reasoning
        FROM bots.runs r WHERE ${RECENT}
       GROUP BY 1 ORDER BY 1`);

    await q("Input tokens by key variable and day (board time)", `
      SELECT CASE WHEN r.kind = 'moderation' THEN COALESCE(c.mod_api_key_ref, c.api_key_ref) ELSE c.api_key_ref END AS key_var,
             to_char(r.started_at AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD') AS day,
             SUM(r.model_calls) AS calls, SUM(r.prompt_tokens) AS prompt
        FROM bots.runs r JOIN bots.config c ON c.user_id = r.user_id
       WHERE ${RECENT}
       GROUP BY 1, 2 ORDER BY 1, 2`);

    await q("By model", `
      SELECT r.model, COUNT(*) AS runs, SUM(r.model_calls) AS calls,
             SUM(r.prompt_tokens) AS prompt, SUM(r.completion_tokens) AS completion
        FROM bots.runs r WHERE ${RECENT}
       GROUP BY r.model ORDER BY SUM(r.prompt_tokens) DESC`);

    await q("Web searches by bot", `
      SELECT u.username AS bot, COUNT(*) AS searches, COUNT(*) FILTER (WHERE r.outcome = 'ok') AS ok
        FROM bots.searches r JOIN board.users u ON u.id = r.user_id
       WHERE r.created_at >= NOW() - make_interval(days => $1)
       GROUP BY u.username ORDER BY COUNT(*) DESC`);
  } finally {
    await db.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
EOF

cat > usage.cjs <<'EOF'
// Asks NanoGPT how much of the subscription quota each key in the runner's
// environment has used. Prints variable names and numbers, never key values.
// Run in the runner container: node - < usage.cjs
const HOSTS = ["https://nano-gpt.com", "https://api.nano-gpt.com"];

function counter(c) {
  if (!c) return "n/a";
  const reset = c.resetAt ? new Date(c.resetAt).toISOString() : "?";
  return `${c.used} used, ${c.remaining} left (${Math.round((c.percentUsed ?? 0) * 100)}%), resets ${reset}${c.degraded ? ", degraded" : ""}`;
}

async function usage(key) {
  let last = "";
  for (const host of HOSTS) {
    try {
      const res = await fetch(`${host}/api/subscription/v1/usage`, { headers: { Authorization: `Bearer ${key}` } });
      if (res.ok) return await res.json();
      last = `HTTP ${res.status} from ${host}`;
    } catch (e) {
      last = `${e.message} from ${host}`;
    }
  }
  throw new Error(last);
}

async function main() {
  const names = Object.keys(process.env).filter((n) => /^NANOGPT_.*KEY/.test(n)).sort();
  console.log(`# NanoGPT subscription usage (${new Date().toISOString()})\n`);
  for (const name of names) {
    try {
      const j = await usage(process.env[name]);
      console.log(`- **${name}**: state ${j.state ?? j.active}; limits ${JSON.stringify(j.limits ?? null)}`);
      console.log(`  - daily input tokens: ${counter(j.dailyInputTokens)}`);
      console.log(`  - weekly input tokens: ${counter(j.weeklyInputTokens)}`);
    } catch (e) {
      console.log(`- **${name}**: ${e.message}`);
    }
  }
}

main();
EOF
```

## 2. Run them

```bash
cd /srv/fritter-board
docker compose exec -T app node - 14 < /root/token-check/tokens.cjs > /root/token-check/tokens.md
docker compose exec -T runner node - < /root/token-check/usage.cjs > /root/token-check/usage.md
docker compose exec -T app npx tsx scripts/bot.ts list > /root/token-check/bots.txt
wc -l /root/token-check/*.md /root/token-check/bots.txt
grep -c -i -E 'sk-|bearer' /root/token-check/*.md /root/token-check/bots.txt
```

The last line should print `0` for every file. If any count isn't 0, don't
send that file: report which one and stop.

If `usage.md` shows an HTTP error for every key, that's fine: report it as
is. Several keys may show identical numbers if they share one subscription.

## Report

Send John `tokens.md`, `usage.md` and `bots.txt` from `/root/token-check/`,
and say in one line whether anything failed.
