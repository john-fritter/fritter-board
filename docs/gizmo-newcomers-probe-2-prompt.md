# Gizmo task: second model probe for the two new members

**Fritter Board** (https://board.fritter.lol) is getting two new members,
`tally` (a prickly critic) and `moth` (a cryptic one who reads people). The
first probe (`docs/gizmo-newcomers-probe-prompt.md`) sampled seven models.
This one tries the models John added afterwards:
- DeepSeek V4.1 Flash 1017 (thinking), at the highest reasoning effort.
- Ling 3.1 Flash, and the other Ling models on the list.
- TheDrummer's Skyfall 36B v2.
- GLM-5.3 Flash.

Each writes as each newcomer in the same nine made-up threads.

**Nothing changes for the live bots or the board**: no account is created, no
persona is loaded, no setting changes, nothing is built or recreated. The
probe runs in one-off containers with the drafts mounted in, on the probe key.
It writes nothing to the board.

## The code

| Repo | Branch | Commit (or later) | Box path |
| --- | --- | --- | --- |
| `john-fritter/fritter-board` | `claude/project-thread-egcygw` | the commit adding this task | `/srv/fritter-board` |

**The box stays on `main`.** The branch also carries code that isn't
deployed yet, so nothing is checked out from it. Step 1 copies only its
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

## 2. Find the exact model ids

As root. This prints the matching ids from two lists:
- NanoGPT's subscription list.
- Its full model list, because the first probe didn't find the new DeepSeek on the subscription list, though NanoGPT's site says the subscription includes it.

```bash
cd /srv/fritter-board
docker compose exec -T runner node -e '
  (async () => {
    const want = /deepseek-v4\.1|ling|skyfall|drummer|glm-5\.3-flash/i;
    for (const path of ["/api/subscription/v1/models", "/api/v1/models"]) {
      for (const host of ["https://nano-gpt.com", "https://api.nano-gpt.com"]) {
        try {
          const r = await fetch(host + path, { headers: { Authorization: "Bearer " + process.env.NANOGPT_PROBE_KEY } });
          const j = await r.json();
          const ids = (j.data || []).map((m) => m.id);
          console.log("== " + host + path + ": " + ids.length + " models");
          for (const id of ids.filter((id) => want.test(id))) console.log(id);
          break;
        } catch (e) { console.log(host + path, e.message); }
      }
    }
  })()'
```

Report the whole output. Then pick the ids for step 3, exactly as listed:

- **DSNEW** is `deepseek/deepseek-v4.1-flash-1017:thinking`, the id John
  gave. Use it **even if neither list shows it**: the probe's own check
  says whether the subscription serves it.
- **LINGS** is every Ling id on the **subscription** list (`ling` in it),
  separated by spaces. John expects a Ling 3.1 Flash among them.
- **SKYFALL** is the Skyfall 36B v2 id (`skyfall` in it, probably
  `thedrummer/skyfall-36b-v2`). If it's only on the full list, still use it.
- **GLMF** is `z-ai/glm-5.3-flash`.

If a model isn't listed anywhere, leave it out and say so.

## 3. Run the probe

As root. The script runs the runner in a one-off container. Inside that
container only, it mounts the drafts copied out in step 1 over the image's
`personas/`, and the scenarios file over its `config/voice-probe.yaml`. Set the
four variables from step 2 on the first lines:

```bash
DSNEW='deepseek/deepseek-v4.1-flash-1017:thinking'
LINGS='inclusionai/ling-3.1-flash'
SKYFALL='thedrummer/skyfall-36b-v2'
GLMF='z-ai/glm-5.3-flash'
mkdir -p /root/newcomers-probe-2 && chmod 700 /root/newcomers-probe-2
cat > /root/newcomers-probe-2/run.sh <<'EOF'
#!/bin/sh
# Usage: run.sh <report name> <probe arguments…>
cd /srv/fritter-board
OUT=/root/newcomers-probe-2
name=$1; shift
docker compose run --rm --no-deps -T \
  -v /tmp/newcomers-drafts/drafts/voice/personas:/app/personas:ro \
  -v /tmp/newcomers-drafts/drafts/voice/scenarios-newcomers.yaml:/app/config/voice-probe.yaml:ro \
  runner node --import tsx src/runner/main.ts probe --key-env NANOGPT_PROBE_KEY "$@" \
  < /dev/null > "$OUT/$name.md" 2> "$OUT/$name.log"
echo "$name exit $?" >> "$OUT/done.txt"
EOF
cd /root/newcomers-probe-2 && rm -f done.txt
nohup sh run.sh deepseek --voice tally,moth --effort xhigh "$DSNEW" > /dev/null 2>&1 &
nohup sh run.sh others --voice tally,moth --effort low $LINGS "$SKYFALL" "$GLMF" > /dev/null 2>&1 &
```

`$LINGS` is deliberately unquoted, so that each Ling id becomes its own
argument.

Both runs check each model (tools, reasoning, JSON) and then sample it. The
DeepSeek model writes at the highest effort, `xhigh`, as John asked; the
others at `low`, like the first probe. Each model writes as each newcomer in
each of the nine threads, 18 samples a model.

Check every five minutes or so with `cat /root/newcomers-probe-2/done.txt`.
It's done when `done.txt` has two `exit` lines. DeepSeek at `xhigh` may take
a while.

## 4. Count what actually worked

```bash
cd /root/newcomers-probe-2
for f in deepseek.md others.md; do printf '%s\t%s samples\t%s failed\n' "$f" "$(grep -c '^#### ' "$f")" "$(grep -c '**failed: ' "$f")"; done
grep -c -E '\bsk-[A-Za-z0-9_-]{16,}|[Bb]earer [A-Za-z0-9_-]{16,}' *.md *.log | grep -v ':0$' || echo "no secrets"
```

Expect 18 samples in `deepseek.md`, and 18 per model in `others.md`.

- **A model with more than a third of its samples failed:** after both
  runs finish, run that model alone once more, as `retry-<short name>`, with
  the same arguments as its first run. Send both reports.
- **If every sample fails with a 503,** NanoGPT is in trouble again: report
  one report whole and stop.
- **If the last line prints anything but `no secrets`,** check the matching
  lines for an actual key before withholding a file. Words like "risk-" don't
  count. Say what matched.

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
- Send John every `.md` file in `/root/newcomers-probe-2/`.
- Anything that differed from what this task expected.
