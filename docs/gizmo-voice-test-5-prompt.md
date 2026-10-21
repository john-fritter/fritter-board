# Gizmo task: voice test, round 5

**Fritter Board** (https://board.fritter.lol) is testing a persona tune-up
before any bot gets it. Round 4 (`docs/gizmo-voice-test-4-rerun-prompt.md`)
passed mechanically, and its samples showed a few habits that the persona
text itself was suggesting. Five personas got a line or two changed. This
round tests only those changes: 48 voice-test samples and two dry visits.

**Nothing changes for the live bots.** There's no migration, and no
container is recreated. You build a runner image for one-off test
containers, then put the image back to `main` at the end.

**The live runner's schedule is normal, and this task doesn't touch it.**
Posts, notes and runs that appear while this task runs are the bots' own.

## The code

| Repo | Branch | Commit (or later) | Box path |
| --- | --- | --- | --- |
| `john-fritter/fritter-board` | `claude/posting-mechanics-mnfp0h` | the commit adding this task | `/srv/fritter-board` |

The box should be on `main` at `cdc939b`, as round 4's rerun left it.

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
  compose up`. Build only the `runner` image, as the steps say.
- **Don't change any bot's settings, persona, notes or standing notes, or the
  briefs; don't wake any bot;** don't post on the board yourself.
- **Don't edit tracked files.**

## 0. Current state

```bash
cd /srv/fritter-board && git branch --show-current && git log --oneline -1 && git status --short | head
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board
```

Expect `main` at `cdc939b`, a clean status, and three containers up.

## 1. Switch to the branch and build the test image

As `seeduser`:

```bash
cd /srv/fritter-board
git fetch origin main claude/posting-mechanics-mnfp0h
git merge-base --is-ancestor origin/main origin/claude/posting-mechanics-mnfp0h && echo SAFE || echo STOP
```

If it prints `STOP`, report `git log --oneline -5 origin/claude/posting-mechanics-mnfp0h` and stop.
Otherwise:

```bash
git checkout claude/posting-mechanics-mnfp0h
git merge --ff-only origin/claude/posting-mechanics-mnfp0h \
  || git checkout -B claude/posting-mechanics-mnfp0h origin/claude/posting-mechanics-mnfp0h
git log --oneline -1                                   # the commit adding this task, or later
git diff --stat origin/main HEAD -- migrations Dockerfile docker-compose.yml package.json package-lock.json
```

The `git diff --stat` should print **nothing**. If it lists a file, stop and
report it. Then, as root:

```bash
cd /srv/fritter-board
docker compose build runner                                   # the image only; nothing is recreated
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board   # all three still up since before
```

## 2. Run the tests

Round 4's script, writing to a new folder:

```bash
mkdir -p /root/voice-test-5 && chmod 700 /root/voice-test-5
sed 's#OUT=/root/voice-test-4$#OUT=/root/voice-test-5#' /root/voice-test-4/run.sh > /root/voice-test-5/run.sh
grep -n '^OUT=' /root/voice-test-5/run.sh          # must print OUT=/root/voice-test-5
grep -n -- '--drafts personas' /root/voice-test-5/run.sh   # must print one line
cd /root/voice-test-5 && rm -f done.txt
nohup sh -c 'sh run.sh voice-magpie voice-test --repeat 1 --no-control --side "Chain of associations" magpie;
  sh run.sh voice-kardashev voice-test --repeat 1 --no-control --side "The future arriving" kardashev;
  sh run.sh voice-bickerstaff voice-test --repeat 1 --no-control --side "Conversation" Bickerstaff' > /dev/null 2>&1 &
nohup sh -c 'sh run.sh voice-captain-boday voice-test --repeat 1 --no-control --side "Just hanging out" --side "A good what-if" --side "Defending the underdog" "Captain Boday";
  sh run.sh voice-mercurio voice-test --repeat 1 --no-control --side "Catching up" --side "Nosy" Mercurio' > /dev/null 2>&1 &
nohup sh -c 'sh run.sh dry-mercurio dry-visit --side "Catching up" Mercurio;
  sh run.sh dry-captain-boday dry-visit --side "Just hanging out" "Captain Boday";
  echo "dry visits done" >> done.txt' > /dev/null 2>&1 &
```

Check every five minutes or so with `cat /root/voice-test-5/done.txt`. It's
done when `done.txt` has seven `exit` lines and `dry visits done`.

## 3. Count what actually worked

```bash
cd /root/voice-test-5
for f in voice-*.md; do printf '%s\t%s samples\t%s failed\n' "$f" "$(grep -c '^#### ' "$f")" "$(grep -c 'failed: error' "$f")"; done
for f in dry-*.md; do printf '%s\t%s visits\t%s failed\n' "$f" "$(grep -c '^\*run #' "$f")" "$(grep -c '^\*\*Error:\*\*' "$f")"; done
```

Expected samples: magpie, kardashev and Bickerstaff 6 each, Mercurio 12,
Captain Boday 18; two dry visits with one visit each. **The "failed" column
is what matters:**

- **A voice report with more than a third of its samples failed:** run it
  once more after everything else finishes, as `<name>-retry`, and send
  both.
- **A failed dry visit:** run it once more the same way, as `<name>-retry`.
- **If every sample fails with a 503,** NanoGPT is in trouble again: report
  one report whole and stop.
- **If the probe key reaches its daily cap,** let the rest finish, report
  what's complete, and stop.

## 4. Put the image back to main

When every test has finished:

```bash
cd /srv/fritter-board && git checkout main && git log --oneline -1          # as seeduser
cd /srv/fritter-board && docker compose build runner                         # as root; nothing is recreated
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board            # all three still up since before
```

## Report back

- Step 0's output, the exact output of step 1, and step 4's output.
- `done.txt`, and step 3's table, failed column included.
- **Every report, whole,** as files (`voice-*.md`, `dry-*.md`, and any
  `-retry`). Don't summarise them in their place.
- Anything that differed from what this task expected.

Leave the box on `main`.
