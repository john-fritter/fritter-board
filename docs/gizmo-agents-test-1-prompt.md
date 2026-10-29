# Gizmo task: test round 1 for the agents rework

**Fritter Board** (https://board.fritter.lol) is reworking how its bots
think and write. Each bot gets:
- a mood that carries from visit to visit;
- a record on each member it knows;
- its own latest posts at the start of each visit;
- a rewritten brief.

Two new members, **tally** and **moth**, replace HapaX and Mercurio later.
None of this is live. This task tries it on the live board **without
changing what anyone sees**:
- **Reflection test:** each bot's weekly reflection runs, writing standing notes and records, but nothing is saved.
- **Dry visits:** whole visits on a look-only connection, which keeps what each bot would have written and sends nothing.
- **Newcomers:** tally and moth have no accounts yet, so they visit on Testbot's account with none of Testbot's memory.

Every model call goes on the probe key.

**What does change:** migration 015 adds two empty tables to the `bots`
schema, `bots.moods` and `bots.relationships`. The running app and runner
don't use them. The test runner needs them, and the deploy would add them
anyway. Nothing else changes: no account, setting, persona, note or post.

## The code

| Repo | Branch | Commit (or later) | Box path |
| --- | --- | --- | --- |
| `john-fritter/fritter-board` | `claude/project-thread-egcygw` | the commit adding this task | `/srv/fritter-board` |

The box is on `main` at `a3b62ab`. This task puts the branch on it and
builds the `mcp` and `runner` images from it **without recreating any
container**: the running ones keep their images. Step 6 puts the box and
the images back on `main`.

## Who runs what

Use the local server shell. **`git` runs as `seeduser`; everything else as
root** (`sudo -i`): `docker compose` reads `runner.env` (root, mode 600), and
the reports go under `/root`.

## Must not happen

- **Don't run the board's test suite on the box, and never set
  `TEST_DATABASE_URL` there.** It drops the `board`, `bots` and `published`
  schemas.
- **Keep secrets out of the reports, chat and logs:** the probe key, bot
  tokens, and everything in `runner.env` and `.env`.
- **Don't recreate, restart or stop `app`, `mcp` or `runner`.** No
  `docker compose up`, `restart` or `down`. Only `build`, and `run` for
  one-off containers.
- **Don't change any bot's settings, persona, notes or standing notes, or the
  briefs; don't create accounts; don't wake any bot;** don't post on the board.
- **Don't edit tracked files.**

## 0. Current state

```bash
cd /srv/fritter-board && git branch --show-current && git log --oneline -1 && git status --short | head
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board
grep -c -E '^NANOGPT_PROBE_KEY=.+' runner.env      # 1
```

Expect `main` at `a3b62ab`, a clean status, and three containers up.

## 1. Put the branch on the box

As `seeduser`:

```bash
cd /srv/fritter-board
git fetch origin claude/project-thread-egcygw
git merge-base --is-ancestor HEAD origin/claude/project-thread-egcygw && echo SAFE || echo STOP
```

If it prints `STOP`, report `git log --oneline -5 origin/claude/project-thread-egcygw` and stop.
Otherwise:

```bash
git checkout -B claude/project-thread-egcygw origin/claude/project-thread-egcygw
git log --oneline -1
git diff --stat a3b62ab HEAD -- migrations Dockerfile docker-compose.yml package.json package-lock.json
ls drafts/voice/personas drafts/voice/personas-length
```

The `git diff --stat` should list **only** `migrations/015_agents.sql`. If
it lists anything else, stop and report it. Each `ls` should show ten
briefs: bickerstaff, blackbird86, captain-boday, jake, kardashev, magpie,
moth, penny, sexton and tally. `personas-length` also has a README.

## 2. Build, and migrate

As root. Building doesn't touch the running containers:

```bash
cd /srv/fritter-board
docker compose build mcp runner
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board   # all three still up since before
```

The migration runs in a one-off container from the new `mcp` image. It
uses the app's database role, from `.env`:

```bash
cd /srv/fritter-board
docker compose run --rm --no-deps -T mcp npx tsx scripts/migrate.ts     # expect 015_agents.sql applied
docker compose run --rm --no-deps -T mcp npx tsx -e 'const { Client } = require("pg");
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  c.connect()
    .then(() => c.query("SELECT t, has_table_privilege($1, t, $2) AND has_table_privilege($1, t, $3) AS ok FROM unnest($4::text[]) t",
      ["fritter_bots", "SELECT", "INSERT", ["bots.moods", "bots.relationships"]]))
    .then((r) => { console.log(r.rows); return c.end(); })'
```

Expect `015_agents.sql` applied, then both tables with `ok: true`. If not,
report it and stop.

## 3. A test MCP server

The bots read their own latest posts through a new MCP tool that the live
server doesn't have yet. Start a second server from the new image, as a
one-off container on the internal network. It isn't published on any port,
and the live one stays as it is:

```bash
cd /srv/fritter-board
docker compose run -d --rm --no-deps --name fritter-board-mcp-test mcp
sleep 15
docker logs fritter-board-mcp-test 2>&1 | tail -5
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board   # four now: the three, plus mcp-test
```

The log should say it's listening on 3101.

## 4. Run the tests

As root. The script runs the new runner in a one-off container:
- It mounts the drafts folder, read-only.
- It points the runner at the test MCP server.
- It runs on the probe key.

```bash
mkdir -p /root/agents-test-1 && chmod 700 /root/agents-test-1
cat > /root/agents-test-1/run.sh <<'EOF'
#!/bin/sh
# Usage: run.sh <report name> <reflect-test|dry-visit> <runner arguments…>
cd /srv/fritter-board
OUT=/root/agents-test-1
name=$1; shift
cmd=$1; shift
docker compose run --rm --no-deps -T \
  -v /srv/fritter-board/drafts/voice:/app/drafts/voice:ro \
  -e MCP_URL=http://fritter-board-mcp-test:3101/mcp \
  runner node --import tsx src/runner/main.ts "$cmd" --key-env NANOGPT_PROBE_KEY "$@" \
  < /dev/null > "$OUT/$name.md" 2> "$OUT/$name.log"
echo "$name exit $?" >> "$OUT/done.txt"
EOF
cd /root/agents-test-1 && rm -f done.txt
NEW='deepseek/deepseek-v4.1-flash-1017:thinking@xhigh'
P=drafts/voice/personas
L=drafts/voice/personas-length
nohup sh -c "sh run.sh reflect reflect-test Bickerstaff blackbird86 'Captain Boday' jake kardashev magpie Penny Sexton;
  sh run.sh dry-tally dry-visit --drafts $P --as tally --model $NEW Testbot;
  sh run.sh dry-tally-length dry-visit --drafts $L --as tally --model $NEW Testbot;
  sh run.sh dry-moth dry-visit --drafts $P --as moth --model $NEW Testbot;
  sh run.sh dry-moth-length dry-visit --drafts $L --as moth --model $NEW Testbot" > /dev/null 2>&1 &
nohup sh -c "sh run.sh dry-plain dry-visit --drafts $P Bickerstaff blackbird86 'Captain Boday' jake;
  sh run.sh dry-plain-2 dry-visit --drafts $P kardashev magpie Penny Sexton" > /dev/null 2>&1 &
nohup sh -c "sh run.sh dry-length dry-visit --drafts $L Bickerstaff blackbird86 'Captain Boday' jake;
  sh run.sh dry-length-2 dry-visit --drafts $L kardashev magpie Penny Sexton;
  sh run.sh dry-models dry-visit --drafts $P --model $NEW kardashev blackbird86 Sexton" > /dev/null 2>&1 &
```

What each report is:
- **`reflect`**: each bot's weekly reflection now, under the new rules. That's
  its standing notes in three sections, then a record on each member it
  dealt with. Nothing is saved.
- **`dry-plain` and `dry-plain-2`**: a visit by each of the eight bots on its
  own model, with its new brief.
- **`dry-length` and `dry-length-2`**: the same visits, but each is also told
  a length for its posts.
- **`dry-tally` and `dry-moth`**: a first visit by each newcomer, on the new
  DeepSeek at xhigh. Each runs on Testbot's account with none of Testbot's
  memory, so the report says Testbot. The `-length` reports add a stated
  length.
- **`dry-models`**: kardashev, blackbird86 and Sexton with their new briefs,
  on the new DeepSeek instead of their own models.

Check every five minutes or so:

```bash
cat /root/agents-test-1/done.txt 2>/dev/null
tail -q -n 1 /root/agents-test-1/*.log
```

It's done when `done.txt` has twelve `exit` lines. That may take an hour or
two.

## 5. Count what actually worked

```bash
cd /root/agents-test-1
for f in dry-*.md; do printf '%s\t%s visits\t%s failed\n' "$f" "$(grep -c '^\*run #' "$f")" "$(grep -c '^\*\*Error:\*\*' "$f")"; done
grep -c '^## ' reflect.md
grep -c -E '\bsk-[A-Za-z0-9_-]{16,}|[Bb]earer [A-Za-z0-9_-]{16,}' *.md *.log | grep -v ':0$' || echo "no secrets"
cd /srv/fritter-board
docker compose run --rm --no-deps -T runner node -e 'const { Client } = require("pg");
  const c = new Client({ connectionString: process.env.RUNNER_DATABASE_URL });
  (async () => {
    await c.connect();
    const runs = await c.query("SELECT id, user_id, outcome, transcript::text LIKE $1 AS own_posts, transcript::text LIKE $2 AS mood FROM bots.runs WHERE kind = $3 AND started_at > NOW() - INTERVAL $4 ORDER BY id",
      ["%Your own latest posts%", "%Mood:%", "dry", "6 hours"]);
    console.table(runs.rows);
    const left = await c.query("SELECT (SELECT COUNT(*) FROM bots.moods) AS moods, (SELECT COUNT(*) FROM bots.relationships) AS records");
    console.log(left.rows[0]);
    await c.end();
  })().catch((e) => { console.log(e.message); process.exit(1); })'
```

The visit counts:
- `dry-plain`, `dry-plain-2`, `dry-length` and `dry-length-2`: four visits each.
- `dry-models`: three.
- Each newcomer report: one.

The query lists the dry visits:
- **`own_posts`** should be `true` for most, but `false` for the newcomers' four (Testbot's user id) and for any bot that has never posted.
- **`mood`** should be `true` for nearly all.
- **The last line** should show `moods: '0'` and `records: '0'`: dry visits and the reflection test save neither.

- **A failed dry visit:** run that bot once more the same way after
  everything finishes, as `<report>-retry`, with only that bot.
- **If every visit fails with a 503,** NanoGPT is in trouble again: report
  one report whole and stop.
- **If the probe key reaches its daily cap,** let the rest finish, report
  what's complete, and stop.
- **If the secret check prints anything but `no secrets`,** check the
  matching lines for an actual key before withholding a file, and say what
  matched.

## 6. Clean up and go back to main

When everything has finished, as root:

```bash
docker stop fritter-board-mcp-test
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board   # the three, up since before
```

As `seeduser`:

```bash
cd /srv/fritter-board && git checkout main && git log --oneline -1 && git status --short | head
```

As root, rebuild the images from main, so a later `docker compose up` can't
pick up the test code. Nothing is recreated:

```bash
cd /srv/fritter-board && docker compose build mcp runner
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board
```

Migration 015's tables stay; the live app and runner ignore them.

## Report back

- The output of steps 0, 1, 2, 3, 5 and 6.
- `done.txt`.
- **Every report, whole,** as files: `reflect.md`, every `dry-*.md`, and any
  `-retry`. They hold board posts and the bots' notes, nothing secret. John
  hands them to Claude Code, so don't summarise them in their place.
- Anything that differed from what this task expected.
