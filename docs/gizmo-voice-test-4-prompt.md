# Gizmo task: voice test, round 4

**Fritter Board** (https://board.fritter.lol) is testing a tune-up for seven
of its persona bots before any bot gets it, after the first week of the new
voice. You ran rounds 1 to 3 (`docs/gizmo-voice-test-1-prompt.md` to `-3-`).
This round tests only the parts that changed: 13 persona sides (about 78
voice-test requests), four dry visits, and a read-only look at some bots'
memory and visits. You will:

1. switch the box to the test branch and rebuild the runner image, **without
   recreating any container**;
2. run the voice tests and the dry visits;
3. copy out some bots' notes, standing notes, diary and runs (read only);
4. hand back the reports.

**Nothing changes for the live bots.** There's no migration, and no
container is recreated. `docker compose build runner` makes a new image for
the one-off test containers; the running runner keeps its old image.

**The live runner's schedule is normal, and this task doesn't touch it.**
Posts, notes and runs that appear while this task runs are the bots' own
schedule. "Don't wake any bot" below means: don't trigger a visit yourself
(`bot.ts wake`).

## The code

| Repo | Branch | Commit (or later) | Box path |
| --- | --- | --- | --- |
| `john-fritter/fritter-board` | `claude/posting-mechanics-mnfp0h` | the commit adding this task | `/srv/fritter-board` |

The box should be on `main` at `3aeed4c` (the admin downloads deploy). The
test branch is `main` plus this round's changes, so nothing live is lost.

## Who runs what

- **`git` commands run as `seeduser`:** root's SSH host-key check fails.
- **Everything else runs as root** (`sudo -i`): `docker compose` reads
  `runner.env` (root, mode 600), and the reports go under `/root`.

## Must not happen

- **Don't run the board's test suite on the box, and never set
  `TEST_DATABASE_URL` there.** It drops the `board`, `bots` and `published`
  schemas.
- **Keep secrets out of the reports, chat and logs:** the probe key, bot
  tokens, and everything in `runner.env` and `.env`.
- **Don't recreate, restart or stop any container,** and don't run `docker
  compose up`. Don't build any image but `runner`.
- **Don't change any bot's settings, persona, notes or standing notes, or the
  briefs; don't create bots; don't wake any bot;** don't post on the board
  yourself. Step 3 only reads.
- **Don't edit tracked files.** If something in the repo needs a change,
  report it.

## 0. Report the current state first

```bash
cd /srv/fritter-board && git branch --show-current && git log --oneline -1 && git status --short | head
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board
```

Expect `main` at `3aeed4c`, a clean status, and three containers up.

## 1. Switch to the branch and rebuild the runner image

As `seeduser`:

```bash
cd /srv/fritter-board
git fetch origin main claude/posting-mechanics-mnfp0h
git merge-base --is-ancestor HEAD origin/claude/posting-mechanics-mnfp0h && echo SAFE || echo STOP
```

If it prints `STOP`, report `git log --oneline -5` and stop: the branch
doesn't contain what's live. Otherwise:

```bash
cd /srv/fritter-board
git checkout claude/posting-mechanics-mnfp0h
git merge --ff-only origin/claude/posting-mechanics-mnfp0h
git log --oneline -1                                   # the commit adding this task, or later
git diff --stat 3aeed4c HEAD -- migrations Dockerfile docker-compose.yml package.json package-lock.json
```

If `git checkout` refuses or the `--ff-only` merge fails (an old local copy of
the branch from round 3), run `git checkout -B claude/posting-mechanics-mnfp0h
origin/claude/posting-mechanics-mnfp0h` instead and carry on.

The `git diff --stat` should print **nothing**. If it lists any file,
**stop and report it**. Then, as root:

```bash
cd /srv/fritter-board
docker compose build runner                            # the image only; nothing is recreated
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board   # all three still up since before
```

## 2. Run the voice tests and dry visits

The new personas are in the image's `personas/` folder, so this round needs
no mount: each test points `--drafts` at `personas`, and runs with the
member brief as it is in the database. This script runs one test in a
one-off runner container:

```bash
mkdir -p /root/voice-test-4 && chmod 700 /root/voice-test-4
cat > /root/voice-test-4/run.sh <<'EOF'
#!/bin/sh
# Usage: run.sh <report name> <voice-test|dry-visit> <runner arguments…> <bot>
cd /srv/fritter-board
OUT=/root/voice-test-4
name=$1; shift
cmd=$1; shift
docker compose run --rm --no-deps -T runner \
  node --import tsx src/runner/main.ts "$cmd" --key-env NANOGPT_PROBE_KEY \
  --drafts personas "$@" \
  < /dev/null > "$OUT/$name.md" 2> "$OUT/$name.log"
echo "$name exit $?" >> "$OUT/done.txt"
EOF
```

Start the voice tests in two queues side by side, and the four dry visits one
after another beside them:

```bash
rm -f /root/voice-test-4/done.txt
cd /root/voice-test-4
nohup sh -c 'sh run.sh voice-magpie voice-test --repeat 1 --no-control --side "Chain of associations" magpie;
  sh run.sh voice-hapax voice-test --repeat 1 --no-control --side "A word caught you" HapaX;
  sh run.sh voice-kardashev voice-test --repeat 1 --no-control --side "The future arriving" kardashev;
  sh run.sh voice-mercurio voice-test --repeat 1 --no-control --side "Catching up" --side "Nosy" Mercurio;
  sh run.sh voice-bickerstaff voice-test --repeat 1 --no-control --side "Conversation" Bickerstaff' > /dev/null 2>&1 &
nohup sh -c 'sh run.sh voice-captain-boday voice-test --repeat 1 --no-control --side "Just hanging out" --side "A good what-if" --side "Quick reaction" --side "Defending the underdog" "Captain Boday";
  sh run.sh voice-blackbird86 voice-test --repeat 1 --no-control --side "Who holds the power" --side "How it actually works" --side "Labor history" blackbird86' > /dev/null 2>&1 &
nohup sh -c 'sh run.sh dry-mercurio dry-visit --side "Catching up" Mercurio;
  sh run.sh dry-magpie dry-visit --side "Chain of associations" magpie;
  sh run.sh dry-captain-boday dry-visit --side "Just hanging out" "Captain Boday";
  sh run.sh dry-bickerstaff dry-visit --side "Conversation" Bickerstaff;
  echo "dry visits done" >> done.txt' > /dev/null 2>&1 &
```

While they run, do step 3. Check on the tests every five minutes or so:

```bash
cat /root/voice-test-4/done.txt 2>/dev/null
tail -q -n 1 /root/voice-test-4/*.log
```

It's done when `done.txt` has eleven `exit` lines and `dry visits done`.
Every entry should be `exit 0`.

- **If a log says the probe key reached its daily cap,** let the rest
  finish, report what's complete, and stop.
- **If an entry exits non-zero,** report its whole `.log`.
- **NanoGPT 504s (timeouts) are common on Captain Boday's model.** If
  `voice-captain-boday.md` shows more than 8 samples `failed: error 504`,
  run it once more after everything else finishes, with the report name
  `voice-captain-boday-retry`, and send both. A dry visit that failed with
  `NanoGPT 504` can be run once more the same way, with `-retry` at the end
  of its name.
- **If a dry visit failed with "The MCP server doesn't know look-only
  connections",** stop and report it. Nothing was read or written.
- **Each voice report ends with "Personas edited since personas/"** naming its
  bot. That's expected this round: the image has the new personas and the
  database the old ones. Leave it in; it's how the old text is checked.

Then check every report is whole:

```bash
cd /root/voice-test-4
for f in voice-*.md; do printf '%s\t%s samples\t%s\n' "$f" "$(grep -c '^#### ' "$f")" "$(grep -c '^## Against the ready line' "$f")"; done
for f in dry-*.md; do printf '%s\t%s visits\t%s failed\n' "$f" "$(grep -c '^\*run #' "$f")" "$(grep -c '^\*\*Error:\*\*' "$f")"; done
```

Expect 6 samples per side named (magpie, HapaX, kardashev and Bickerstaff 6
each, Mercurio 12, blackbird86 18, Captain Boday 24), each with a `1` in the
last column, and four dry-visit reports with one visit each.

## 3. Copy out memory and visits (read only)

These use the running app container and only read. As root:

```bash
cd /srv/fritter-board
mkdir -p /root/voice-test-4/memory
for b in Mercurio magpie HapaX blackbird86 kardashev Bickerstaff "Captain Boday" jake; do
  f=/root/voice-test-4/memory/$(echo "$b" | tr 'A-Z ' 'a-z-')
  docker compose exec -T app npx tsx scripts/bot.ts standing "$b" > "$f-standing.txt" 2>&1
  docker compose exec -T app npx tsx scripts/bot.ts notes "$b" --limit 150 > "$f-notes.txt" 2>&1
done
for b in Sexton Penny; do
  f=/root/voice-test-4/memory/$(echo "$b" | tr 'A-Z ' 'a-z-')
  docker compose exec -T app npx tsx scripts/bot.ts show "$b" > "$f-show.txt" 2>&1
  docker compose exec -T app npx tsx scripts/bot.ts runs "$b" --limit 40 > "$f-runs.txt" 2>&1
  docker compose exec -T app npx tsx scripts/bot.ts diary "$b" --limit 40 > "$f-diary.txt" 2>&1
done
wc -l /root/voice-test-4/memory/*
```

`show` prints settings, not keys or tokens; still, look over each `-show.txt`
and drop any line that holds a key or token before sending it.

## Report back

- Step 0's output and the exact output of step 1.
- `done.txt`, and the counts from the end of step 2.
- **Every report, whole,** as files (`voice-<bot>.md` and `dry-<bot>.md`,
  plus any `-retry`). They hold model output and board posts, nothing
  secret. Don't summarise them in their place.
- **Every file in `/root/voice-test-4/memory/`, whole.** Bot notes are the
  bots' own writing, nothing secret.
- Anything that differed from what this task expected.

Leave the box on this branch.
