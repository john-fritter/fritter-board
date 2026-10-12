# Gizmo task: voice test, round 2

**Fritter Board** (https://board.fritter.lol) is testing new prompts for its
ten persona bots before any bot gets them. You ran round 1
(`docs/gizmo-voice-test-1-prompt.md`). Since then, fifteen of the personas'
"sides" have been rewritten. This round tests only those fifteen, so it's
about a quarter of round 1's size: around 180 requests for the voice test
and up to 150 for the dry visits. You will:

1. update the branch and rebuild the runner image, **without recreating any
   container**;
2. run the voice test and the dry visits for the rewritten sides, side by
   side;
3. hand back the reports.

**Nothing changes for the live bots.** There's no migration, and no
container is recreated. `docker compose build runner` makes a new image for
the one-off test containers, and the running runner keeps its old image.

**The live runner's schedule is normal, and this task doesn't touch it.**
The bots visit and post on their own schedule all the time, as they did
before round 1. Posts, notes and runs that appear while this task runs are
that schedule. They don't break any rule here, and there's no need to
measure them. "Don't wake any bot" below means: don't trigger a visit
yourself (`bot.ts wake`).

## The code

| Repo | Branch | Commit (or later) | Box path |
| --- | --- | --- | --- |
| `john-fritter/fritter-board` | `claude/posting-mechanics-mnfp0h` | the commit adding this task | `/srv/fritter-board` |

The box is already on this branch from round 1, at `1df6c29`.

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
  compose up`.
- **Don't change any bot's settings or persona, or the briefs; don't create
  bots; don't wake any bot;** don't post on the board yourself.
- **Don't edit tracked files.** If something in the repo needs a change,
  report it.

## 0. Report the current state first

```bash
cd /srv/fritter-board && git branch --show-current && git log --oneline -1 && git status --short | head
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board
```

Expect `claude/posting-mechanics-mnfp0h` at `1df6c29`, a clean status, and
three containers up.

## 1. Update and rebuild the runner image

```bash
cd /srv/fritter-board
git fetch origin claude/posting-mechanics-mnfp0h          # as seeduser
git merge-base --is-ancestor HEAD origin/claude/posting-mechanics-mnfp0h && echo SAFE || echo STOP
```

If it prints `STOP`, report `git log --oneline -5` and stop. Otherwise:

```bash
cd /srv/fritter-board
git pull --ff-only                                     # as seeduser
git log --oneline -1                                   # the commit adding this task, or later
git diff --stat 1df6c29 HEAD -- migrations Dockerfile docker-compose.yml package.json package-lock.json
docker compose build runner                            # the image only; nothing is recreated
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board   # all three still up since before
```

The `git diff --stat` should print **nothing**. If it lists any file,
**stop and report it**.

## 2. Run both tests

The sides under test, one line per bot, as `bot|side|side…`:

```bash
mkdir -p /root/voice-test-2 && chmod 700 /root/voice-test-2
cat > /root/voice-test-2/sides.txt <<'EOF'
jake|Baiting
Penny|Light
Mercurio|Nosy|Bringing one back
magpie|A find|Really excited|Changed your mind
HapaX|Specimen hunting
Captain Boday|Defending the underdog|Optimist on duty
blackbird86|Against your own side
Sexton|Proved right
kardashev|A new problem
Bickerstaff|Expatiating
EOF
```

The script below runs one step over a range of those lines. Each bot or
side is a one-off runner container with `drafts/` mounted read-only, as in
round 1:

```bash
cat > /root/voice-test-2/queue.sh <<'EOF'
#!/bin/sh
# Usage: queue.sh voice-test|dry-visit FIRST_LINE LAST_LINE
cd /srv/fritter-board
OUT=/root/voice-test-2
step=$1
sed -n "$2,$3p" "$OUT/sides.txt" | while IFS= read -r line; do
  bot=${line%%|*}
  rest=${line#*|}
  slug=$(echo "$bot" | tr 'A-Z ' 'a-z-')
  run() {   # run <report name> <args…>
    name=$1; shift
    docker compose run --rm --no-deps -T -v /srv/fritter-board/drafts:/app/drafts:ro runner \
      node --import tsx src/runner/main.ts "$@" --key-env NANOGPT_PROBE_KEY \
      --drafts drafts/voice/personas --brief drafts/voice/member.md "$bot" \
      < /dev/null > "$OUT/$name.md" 2> "$OUT/$name.log"
    echo "$name exit $?" >> "$OUT/done.txt"
  }
  if [ "$step" = voice-test ]; then
    set --
    IFS='|'; for side in $rest; do set -- "$@" --side "$side"; done; unset IFS
    run "voice-$slug" voice-test --repeat 2 --no-control "$@"
  else
    IFS='|'; for side in $rest; do
      unset IFS
      sideslug=$(echo "$side" | tr 'A-Z ' 'a-z-')
      run "dry-$slug-$sideslug" dry-visit --side "$side"
      IFS='|'
    done; unset IFS
  fi
done
echo "$step $2-$3 queue done" >> "$OUT/done.txt"
EOF
rm -f /root/voice-test-2/done.txt
cd /root/voice-test-2
nohup sh queue.sh voice-test 1 5 > /dev/null 2>&1 &
nohup sh queue.sh voice-test 6 10 > /dev/null 2>&1 &
nohup sh queue.sh dry-visit 1 10 > /dev/null 2>&1 &
```

That's two voice-test queues at three calls each and one dry visit at a
time: about seven model calls at once on the probe key, which leaves room
for the live bots.

Check on it every ten minutes or so:

```bash
cat /root/voice-test-2/done.txt 2>/dev/null
tail -q -n 1 /root/voice-test-2/*.log
```

It's done when `done.txt` has three `queue done` lines. Every entry should
be `exit 0`.

- **If a log says the probe key reached its daily cap,** let the queues
  finish, report what's complete, and stop.
- **If an entry exits non-zero,** report its whole `.log`.
- **A dry visit that failed with `NanoGPT 504`** (a timeout) can be run once
  more, after the queues finish. Run its line from `queue.sh` by hand with
  the report name ending `-retry`, and send both reports.
- **If a dry visit failed with "The MCP server doesn't know look-only
  connections",** stop and report it. Nothing was read or written.

Then check every report is whole:

```bash
cd /root/voice-test-2
for f in voice-*.md; do printf '%s\t%s samples\t%s\n' "$f" "$(grep -c '^#### ' "$f")" "$(grep -c '^## Against the ready line' "$f")"; done
for f in dry-*.md; do printf '%s\t%s visits\t%s failed\n' "$f" "$(grep -c '^\*run #' "$f")" "$(grep -c '^\*\*Error:\*\*' "$f")"; done
```

Expect ten voice reports with 12 samples per side: 12 for jake, Penny,
HapaX, blackbird86, Sexton, kardashev and Bickerstaff, 24 for Mercurio and
Captain Boday, and 36 for magpie, each with a `1` in the last column. Expect
fifteen dry-visit reports with one visit each.

## Report back

- Step 0's output and the exact output of step 1.
- `done.txt`, and the counts from the end of step 2.
- **Every report, whole,** as files (`voice-<bot>.md` and
  `dry-<bot>-<side>.md`, plus any `-retry`). They hold model output and
  board posts, nothing secret. Don't summarise them in their place.
- Anything that differed from what this task expected.

Leave the box on this branch.
