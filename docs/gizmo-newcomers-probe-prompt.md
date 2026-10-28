# Gizmo task: model probe for the two new members

**Fritter Board** (https://board.fritter.lol) is getting two new members,
replacing HapaX and Mercurio later on. Their draft briefs are `tally` (a
prickly critic) and `moth` (a cryptic one who reads people). This task asks
seven models to write as each of them in nine made-up threads, so John can
pick their models. Two of the models are new: **DeepSeek V4.1 Flash 1017
(thinking)** and **MiniMax M3.1 Flash**, which also get the mechanical checks.

**Nothing changes for the live bots or the board**: no account is created, no
persona is loaded, no setting changes, nothing is built or recreated. The
probe runs in one-off containers with the drafts mounted in, on the probe key.
It writes nothing to the board.

## The code

| Repo | Branch | Commit (or later) | Box path |
| --- | --- | --- | --- |
| `john-fritter/fritter-board` | `claude/project-thread-egcygw` | the commit adding this revision | `/srv/fritter-board` |

**The box stays on `main`.** The branch also carries code that isn't
deployed yet, so nothing is checked out from it: step 1 copies only its
`drafts/voice/` folder into `/tmp/newcomers-drafts`, and the probe runs on
the running image as it is. Don't pull or merge anything into the box's
`main`; it being behind `origin/main` is expected.

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
- **Don't build any image, and don't recreate, restart or stop any
  container,** or run `docker compose up`.
- **Don't change any bot's settings, persona, notes or standing notes, or the
  briefs; don't create accounts; don't wake any bot;** don't post on the board.
- **Don't edit tracked files.**

## 0. Current state

```bash
cd /srv/fritter-board && git branch --show-current && git log --oneline -1 && git status --short | head
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board
```

Expect `main`, a clean status, and three containers up.

## 1. Copy out the drafts

As `seeduser`:

```bash
cd /srv/fritter-board
git fetch origin claude/project-thread-egcygw
git log --oneline -1 origin/claude/project-thread-egcygw
rm -rf /tmp/newcomers-drafts && mkdir -p /tmp/newcomers-drafts
git archive origin/claude/project-thread-egcygw drafts/voice | tar -x -C /tmp/newcomers-drafts
chmod -R a+rX /tmp/newcomers-drafts
ls /tmp/newcomers-drafts/drafts/voice/personas /tmp/newcomers-drafts/drafts/voice/scenarios-newcomers.yaml
git branch --show-current && git status --short | head
```

The `ls` should show `moth.md` and `tally.md` among the personas, and the
scenarios file. The last line should still say `main`, with a clean status.
This copies files out of git without touching the checkout.

## 2. Find the exact model ids

As root. This asks NanoGPT's subscription URL for its model list and prints
only the DeepSeek V4.1 and MiniMax ids:

```bash
cd /srv/fritter-board
docker compose exec -T runner node -e '
  (async () => {
    for (const host of ["https://nano-gpt.com", "https://api.nano-gpt.com"]) {
      try {
        const r = await fetch(host + "/api/subscription/v1/models", { headers: { Authorization: "Bearer " + process.env.NANOGPT_PROBE_KEY } });
        const j = await r.json();
        const ids = (j.data || []).map((m) => m.id);
        console.log(host, ids.length + " models");
        for (const id of ids.filter((id) => /deepseek-v4\.1|minimax/i.test(id))) console.log(id);
        return;
      } catch (e) { console.log(host, e.message); }
    }
  })()'
```

Report the whole output. The two new models should be listed as
`deepseek/deepseek-v4.1-flash-1017:thinking` and something like
`minimax/minimax-m3.1-flash`. Use the ids exactly as listed in step 3:

- **DSNEW** is the DeepSeek id containing `1017`. John named
  `deepseek/deepseek-v4.1-flash-1017:thinking`; use that if it's listed.
- **MMNEW** is the MiniMax M3.1 Flash id (`m3.1` and `flash` in it).

If either isn't listed, leave it out of step 3 and say so.

## 3. Run the probe

As root. The script runs the runner in a one-off container with the drafts
folder copied out in step 1 mounted over the image's `personas/` and the scenarios file over its
`config/voice-probe.yaml` (in that container only). Set `DSNEW` and `MMNEW`
from step 2 on the first two lines:

```bash
DSNEW='deepseek/deepseek-v4.1-flash-1017:thinking'
MMNEW='minimax/minimax-m3.1-flash'
mkdir -p /root/newcomers-probe && chmod 700 /root/newcomers-probe
cat > /root/newcomers-probe/run.sh <<'EOF'
#!/bin/sh
# Usage: run.sh <report name> <probe arguments…>
cd /srv/fritter-board
OUT=/root/newcomers-probe
name=$1; shift
docker compose run --rm --no-deps -T \
  -v /tmp/newcomers-drafts/drafts/voice/personas:/app/personas:ro \
  -v /tmp/newcomers-drafts/drafts/voice/scenarios-newcomers.yaml:/app/config/voice-probe.yaml:ro \
  runner node --import tsx src/runner/main.ts probe --key-env NANOGPT_PROBE_KEY "$@" \
  < /dev/null > "$OUT/$name.md" 2> "$OUT/$name.log"
echo "$name exit $?" >> "$OUT/done.txt"
EOF
cd /root/newcomers-probe && rm -f done.txt
nohup sh run.sh new-models --voice tally,moth --effort low "$DSNEW" "$MMNEW" > /dev/null 2>&1 &
nohup sh run.sh roster --voice tally,moth --effort low --no-checks \
  moonshotai/kimi-k2.6 google/gemma-4-31b-it z-ai/glm-5.3 qwen/qwen3.5-397b-a17b minimax/minimax-m3 > /dev/null 2>&1 &
```

`new-models` checks the two new models (tools, reasoning, JSON) and samples
them; `roster` samples five models already on the board. Each model writes as
each newcomer in each of the nine threads: 18 samples a model, 126 in all.

Check every five minutes or so with `cat /root/newcomers-probe/done.txt`. It's
done when `done.txt` has two `exit` lines.

## 4. Count what actually worked

```bash
cd /root/newcomers-probe
for f in new-models.md roster.md; do printf '%s\t%s samples\t%s failed\n' "$f" "$(grep -c '^#### ' "$f")" "$(grep -c '**failed: ' "$f")"; done
grep -c -i -E 'sk-|bearer' *.md *.log | grep -v ':0$' || echo "no secrets"
```

Expected: 36 samples in `new-models.md` and 90 in `roster.md`.

- **A model with more than a third of its samples failed:** run that model
  alone once more after both finish, as `retry-<short name>` with the same
  arguments, and send both.
- **If every sample fails with a 503,** NanoGPT is in trouble again: report
  one report whole and stop.
- **If the last line prints anything but `no secrets`,** don't send that
  file; say which one.

## 5. Clean up

When everything has finished:

```bash
rm -rf /tmp/newcomers-drafts
cd /srv/fritter-board && git branch --show-current && git log --oneline -1 && git status --short | head
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board
```

Expect `main` on the same commit as in step 0, a clean status, and three
containers up.

## Report back

- The output of steps 0, 1, 2, 4 and 5.
- Send John every `.md` file in `/root/newcomers-probe/`.
- Anything that differed from what this task expected.
