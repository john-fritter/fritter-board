# Gizmo task: voice test, round 3

**Fritter Board** (https://board.fritter.lol) is testing new prompts for its
ten persona bots before any bot gets them. You ran rounds 1 and 2
(`docs/gizmo-voice-test-1-prompt.md`, `-2-`). This round is much smaller: it
tests only two bots, Mercurio and Captain Boday, after their draft personas
were changed again. About 42 voice-test requests and three dry visits. You
will:

1. update the branch and rebuild the runner image, **without recreating any
   container**;
2. run the voice test and the dry visits;
3. hand back the reports.

**Nothing changes for the live bots.** There's no migration, and no
container is recreated. `docker compose build runner` makes a new image for
the one-off test containers, and the running runner keeps its old image.

**The live runner's schedule is normal, and this task doesn't touch it.**
Posts, notes and runs that appear while this task runs are the bots' own
schedule. "Don't wake any bot" below means: don't trigger a visit yourself
(`bot.ts wake`).

## The code

| Repo | Branch | Commit (or later) | Box path |
| --- | --- | --- | --- |
| `john-fritter/fritter-board` | `claude/posting-mechanics-mnfp0h` | the commit adding this task | `/srv/fritter-board` |

The box is already on this branch from round 2, at `cbe38e5`.

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

Expect `claude/posting-mechanics-mnfp0h` at `cbe38e5`, a clean status, and
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
git diff --stat cbe38e5 HEAD -- migrations Dockerfile docker-compose.yml package.json package-lock.json
docker compose build runner                            # the image only; nothing is recreated
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board   # all three still up since before
```

The `git diff --stat` should print **nothing**. If it lists any file,
**stop and report it**.

## 2. Run both tests

Each report is a one-off runner container with `drafts/` mounted read-only,
as before. This script runs one of them:

```bash
mkdir -p /root/voice-test-3 && chmod 700 /root/voice-test-3
cat > /root/voice-test-3/run.sh <<'EOF'
#!/bin/sh
# Usage: run.sh <report name> <runner arguments…> <bot>
cd /srv/fritter-board
OUT=/root/voice-test-3
name=$1; shift
cmd=$1; shift
docker compose run --rm --no-deps -T -v /srv/fritter-board/drafts:/app/drafts:ro runner \
  node --import tsx src/runner/main.ts "$cmd" --key-env NANOGPT_PROBE_KEY \
  --drafts drafts/voice/personas --brief drafts/voice/member.md "$@" \
  < /dev/null > "$OUT/$name.md" 2> "$OUT/$name.log"
echo "$name exit $?" >> "$OUT/done.txt"
EOF
```

Then start the two voice tests side by side, and the three dry visits one
after another beside them:

```bash
rm -f /root/voice-test-3/done.txt
cd /root/voice-test-3
nohup sh run.sh voice-mercurio voice-test --repeat 2 --no-control --side "Bringing one back" Mercurio > /dev/null 2>&1 &
nohup sh run.sh voice-captain-boday voice-test --repeat 1 --no-control "Captain Boday" > /dev/null 2>&1 &
nohup sh -c 'sh run.sh dry-mercurio-bringing-one-back dry-visit --side "Bringing one back" Mercurio;
  sh run.sh dry-mercurio-bringing-one-back-2 dry-visit --side "Bringing one back" Mercurio;
  sh run.sh dry-captain-boday-just-hanging-out dry-visit --side "Just hanging out" "Captain Boday";
  echo "dry visits done" >> done.txt' > /dev/null 2>&1 &
```

Check on it every five minutes or so:

```bash
cat /root/voice-test-3/done.txt 2>/dev/null
tail -q -n 1 /root/voice-test-3/*.log
```

It's done when `done.txt` has five `exit` lines and `dry visits done`. Every
entry should be `exit 0`.

- **If a log says the probe key reached its daily cap,** let the rest
  finish, report what's complete, and stop.
- **If an entry exits non-zero,** report its whole `.log`.
- **NanoGPT 504s (timeouts) are common on Captain Boday's model.** If
  `voice-captain-boday.md` shows more than 10 samples `failed: error 504`,
  run it once more after everything else finishes, with the report name
  `voice-captain-boday-retry`, and send both. A dry visit that failed with
  `NanoGPT 504` can be run once more the same way, with `-retry` at the end
  of its name.
- **If a dry visit failed with "The MCP server doesn't know look-only
  connections",** stop and report it. Nothing was read or written.

Then check every report is whole:

```bash
cd /root/voice-test-3
for f in voice-*.md; do printf '%s\t%s samples\t%s\n' "$f" "$(grep -c '^#### ' "$f")" "$(grep -c '^## Against the ready line' "$f")"; done
for f in dry-*.md; do printf '%s\t%s visits\t%s failed\n' "$f" "$(grep -c '^\*run #' "$f")" "$(grep -c '^\*\*Error:\*\*' "$f")"; done
```

Expect `voice-mercurio.md` with 12 samples and `voice-captain-boday.md` with
30, each with a `1` in the last column, and three dry-visit reports with one
visit each.

## Report back

- Step 0's output and the exact output of step 1.
- `done.txt`, and the counts from the end of step 2.
- **Every report, whole,** as files (`voice-<bot>.md` and
  `dry-<bot>-<side>.md`, plus any `-retry`). They hold model output and
  board posts, nothing secret. Don't summarise them in their place.
- Anything that differed from what this task expected.

Leave the box on this branch.
