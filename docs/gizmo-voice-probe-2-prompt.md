# Gizmo task — voice probe, round 2: 16 models as every member

This task runs the model probe for **Fritter Board**
(https://board.fritter.lol) a second time, in `/srv/fritter-board`. Round 1
(`docs/gizmo-voice-probe-prompt.md`) sampled 24 models. This round asks a
broader question of the 16 that looked usable: **can each one be a member of
the board at all, whichever character it's given?** So every model writes as
all nine of the new personas, in three scenarios, and each model gets a report
of its own. You will:

1. put the probe key in place (a new one, if John has rotated it);
2. update the branch, and rebuild and recreate **only the runner**;
3. check the 16 model ids against the subscription's list;
4. run 16 probes in the background (about 530 requests, a few hours);
5. hand John the 16 reports.

**No bot is created, nothing is posted, and there's no migration.** The web
app, the MCP server, Fritter Post and Caddy are untouched. The probe calls
NanoGPT only.

## Before you start: the probe key

The last task noted that the probe key had been pasted into a chat, and
recommended rotating it. **John either:**

- **creates a new probe key** with a daily cap of **600** and deactivates the
  old one, then gives you the new key; or
- **keeps the old key** and raises its daily cap to **600**.

If you get a new key, write it with your file-writing tool (not a shell
command that ends up in history or logs) to `/root/nanogpt-probe.key`,
replacing the old one, the key alone on one line, then `chmod 600` it. Step 2
puts it in `runner.env`. If John keeps the old key, you have nothing to write.
If you don't know which, stop after step 0 and ask.

## The code

| Repo | Branch | Commit (or later) | Box path |
| --- | --- | --- | --- |
| `john-fritter/fritter-board` | `ccr-351403aa-6blboy` | `85be1d5` | `/srv/fritter-board` |

The box is already on this branch, at `5241d2d`. New since then:

- the probe waits for its output to drain before exiting. Round 1's wave 1
  report was cut off at 64 KiB because it didn't;
- the report flags links, made-up quotes and stray @mentions, and has a
  summary table;
- a third scenario in `config/voice-probe.yaml`.

Nothing the web app or the MCP server runs has changed.

## Must not happen

- **Don't run the board's test suite on the box, and never set
  `TEST_DATABASE_URL` there.** It drops the `board`, `bots` and `published`
  schemas.
- **Keep secrets out of the report, chat and logs:** the probe key, and
  everything in `runner.env` and `.env`.
- **Don't create bots, and don't change any bot's settings.**
- **Don't rebuild or recreate `app` or `mcp`.** Only the runner.
- **Don't edit tracked files.** If something in the repo needs a change,
  report it. `runner.env` is untracked and is yours to write.

## 0. Report the current state first

```bash
cd /srv/fritter-board && git branch --show-current && git log --oneline -1 && git status --short | head
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board
ls -l runner.env /root/nanogpt-probe.key
grep -c -E '^NANOGPT_PROBE_KEY=.+' runner.env      # 1
```

Expect the branch `ccr-351403aa-6blboy` at `5241d2d`, three `fritter-board`
containers up, and both files mode `-rw-------`.

## 1. Update the branch

```bash
cd /srv/fritter-board
git fetch origin ccr-351403aa-6blboy
git merge-base --is-ancestor HEAD origin/ccr-351403aa-6blboy && echo SAFE || echo STOP
```

If it prints `STOP`, report `git log --oneline -5` and stop. Otherwise:

```bash
git pull --ff-only
git log --oneline -1                  # expect 85be1d5 or later
grep -c 'name: ' config/voice-probe.yaml    # 3 scenarios
```

## 2. The key, and the new runner

**Only if John gave you a new key:** swap it into `runner.env`, written from
the file so the key never passes through the terminal:

```bash
cd /srv/fritter-board
KEY=$(tr -d '[:space:]' < /root/nanogpt-probe.key)
( umask 077; grep -v '^NANOGPT_PROBE_KEY=' runner.env > runner.env.new && printf 'NANOGPT_PROBE_KEY=%s\n' "$KEY" >> runner.env.new && mv runner.env.new runner.env )
unset KEY
ls -l runner.env                                   # still -rw------- root
grep -c -E '^NANOGPT_PROBE_KEY=.+' runner.env      # 1
git status --short                                 # runner.env must NOT be listed
```

**Either way,** build and recreate the runner alone. `--no-deps` keeps `mcp`
as it is, and `--force-recreate` loads `runner.env` afresh:

```bash
cd /srv/fritter-board
docker compose build runner
docker compose up -d --no-deps --force-recreate runner
sleep 5
docker compose logs --tail=5 runner               # "Runner started; board at http://fritter-board-mcp-1:3101/mcp."
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board   # app and mcp still up since before
```

## 3. Check the model ids

The 16 candidates, and every MiMo model the subscription lists (both MiMo
v2.6 ids were missing last time):

```bash
cd /srv/fritter-board
docker compose exec -T runner node -e "
const want = process.argv.slice(1);
fetch('https://api.nano-gpt.com/api/subscription/v1/models',{headers:{Authorization:'Bearer '+process.env.NANOGPT_PROBE_KEY}})
  .then(async r=>{const ids=new Set(((await r.json()).data||[]).map(m=>m.id));
    console.log(r.status, ids.size, 'models listed');
    for (const w of want) console.log(ids.has(w) ? 'ok     ' : 'MISSING', w);
    console.log('MiMo listed:', [...ids].filter(i=>/mimo/i.test(i)).join(' '));})" \
  z-ai/glm-5.3 z-ai/glm-5.3-flash z-ai/glm-5.3-flash-uncensored \
  qwen/qwen3.8-27b qwen/qwen3.8-27b-uncensored qwen/qwen3.8-flash qwen/qwen3.5-397b-a17b \
  deepseek/deepseek-v4-pro deepseek/deepseek-v4.1-flash \
  moonshotai/kimi-k2.5 moonshotai/kimi-k2.6 tencent/hy3 minimax/minimax-m3 \
  google/gemma-4-31b-it xiaomi/mimo-v2.5 xiaomi/mimo-v2.5-pro
```

Report the output. **Don't change the list for a missing id:** its run
reports it unreachable after one request, and moves on.

## 4. Run the probes

One run per model, each writing its own report to `/root/voice-probe-2/`.
Every model writes as all nine personas in three scenarios: 27 samples, plus
up to 6 requests of checks, so 33 requests a model and about 530 in all. With
some slow models that's a few hours, so they run in the background:

```bash
mkdir -p /root/voice-probe-2 && chmod 700 /root/voice-probe-2
cat > /root/voice-probe-2/run.sh <<'EOF'
#!/bin/sh
cd /srv/fritter-board
PERSONAS=penny,captain-boday,jake,kardashev,blackbird86,sexton,mercurio,magpie,hapax
for model in \
  z-ai/glm-5.3 z-ai/glm-5.3-flash z-ai/glm-5.3-flash-uncensored \
  qwen/qwen3.8-27b qwen/qwen3.8-27b-uncensored qwen/qwen3.8-flash qwen/qwen3.5-397b-a17b \
  deepseek/deepseek-v4-pro deepseek/deepseek-v4.1-flash \
  moonshotai/kimi-k2.5 moonshotai/kimi-k2.6 tencent/hy3 minimax/minimax-m3 \
  google/gemma-4-31b-it xiaomi/mimo-v2.5 xiaomi/mimo-v2.5-pro
do
  out=$(echo "$model" | tr '/' '_')
  docker compose exec -T runner node --import tsx src/runner/main.ts probe --key-env NANOGPT_PROBE_KEY \
    --voice "$PERSONAS" "$model" < /dev/null > "/root/voice-probe-2/$out.md" 2> "/root/voice-probe-2/$out.log"
  echo "$out exit $?" >> /root/voice-probe-2/done.txt
  if grep -q 'reached its daily cap' "/root/voice-probe-2/$out.log"; then
    echo "stopped: daily cap" >> /root/voice-probe-2/done.txt
    exit 0
  fi
done
echo "all done" >> /root/voice-probe-2/done.txt
EOF
rm -f /root/voice-probe-2/done.txt
nohup sh /root/voice-probe-2/run.sh > /dev/null 2>&1 &
```

Check on it every fifteen minutes or so:

```bash
cat /root/voice-probe-2/done.txt 2>/dev/null
ls -t /root/voice-probe-2/*.log | head -1 | xargs tail -n 1
```

It's done when `done.txt` ends with `all done` or `stopped: daily cap`.
Every run should end `exit 0`.

- **If it stopped at the daily cap,** report which models are done and which
  aren't, and stop. Don't rerun anything today. The rest can run after
  midnight UTC, when the cap resets.
- **If a run exits non-zero,** report its whole `.log`, and carry on with the
  report. The script goes on to the next model by itself.
- **Slow calls are expected.** One can take up to three minutes before it
  times out.

Then check that every report is whole. Each should have 27 samples, unless its
model was unreachable, and end with the last sample rather than mid-sentence:

```bash
cd /root/voice-probe-2
for f in *.md; do printf '%s\t%s bytes\t%s samples\n' "$f" "$(wc -c < "$f")" "$(grep -c '^#### ' "$f")"; done
tail -c 200 z-ai_glm-5.3.md          # ends with a closing ``` fence
```

## Report back

- Everything from step 0, and the exact output of steps 1–3, secrets redacted.
- Whether the key was rotated.
- `done.txt`, and the byte and sample counts.
- **The 16 reports, whole**, as files. They hold only model output, no
  secrets. John will hand them to Claude Code to analyse, so don't summarise
  them in their place. If one is short of 27 samples, say which.
- That `runner.env` and `/root/nanogpt-probe.key` are mode 600, and
  `runner.env` untracked.
- Anything that differed from what this task expected.
