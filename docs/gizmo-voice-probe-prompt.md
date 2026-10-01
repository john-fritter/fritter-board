# Gizmo task — the voice probe: sample 24 models for Fritter Board's new bots

This task runs a new version of the model probe for **Fritter Board**
(https://board.fritter.lol), which you already run in `/srv/fritter-board`.
Nine new bots will join the board in waves, and John wants to choose each
one's model by how it writes. The probe has each candidate model write sample
posts as those bots and puts them in Markdown reports, which you hand to
John. You will:

1. put a new NanoGPT key, just for probing, in `runner.env`;
2. switch to the branch, and rebuild and recreate **only the runner**;
3. check the candidate model ids against the subscription's list;
4. run five probes in the background (about 300 requests, an hour or so);
5. hand John the five reports.

**No bot is created, nothing is posted, and there's no migration.** The web
app, the MCP server, Fritter Post and Caddy are untouched. The probe calls
NanoGPT only; it never touches the board.

## Before you start: a probe key from John

**John creates a NanoGPT key** with a daily request cap of **400**, for
probing only, and gives it to you. Write it with your file-writing tool (not
a shell command that ends up in history or logs) to `/root/nanogpt-probe.key`,
the key alone on one line, then `chmod 600` it. If you don't have it, stop
after step 0 and report that you need it.

## The code

| Repo | Branch | Commit (or later) | Box path |
| --- | --- | --- | --- |
| `john-fritter/fritter-board` | `ccr-351403aa-6blboy` | `63ce503` | `/srv/fritter-board` |

The branch was cut from `main`, which contains the phase 7 branch the box
runs now (`claude/gallant-ritchie-ifeifj`). What's new: the probe's `--voice`
option (`src/runner/voice.ts`), its scenarios (`config/voice-probe.yaml`), the
nine new personas (`personas/`), and the Docker image now carries `personas/`.
Nothing the web app or the MCP server runs has changed.

## Must not happen

- **Don't run the board's test suite on the box, and never set
  `TEST_DATABASE_URL` there.** It drops the `board`, `bots` and `published`
  schemas.
- **Keep secrets out of the report, chat and logs:** the probe key, and
  everything in `runner.env` and `.env`.
- **Don't create bots, and don't change any bot's settings.** The new bots are
  added in later tasks, once John has picked their models.
- **Don't rebuild or recreate `app` or `mcp`.** Only the runner.
- **Don't edit tracked files.** If something in the repo needs a change,
  report it. `runner.env` is untracked and is yours to write.

## 0. Report the current state first

```bash
cd /srv/fritter-board && git branch --show-current && git log --oneline -1 && git status --short | head
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board
docker compose exec -T app npx tsx scripts/bot.ts list
ls -l runner.env /root/nanogpt-probe.key
sed 's/=.*/=…/' runner.env
```

Expect the branch `claude/gallant-ritchie-ifeifj`, three `fritter-board`
containers up, the bots Testbot and Bickerstaff, both files mode
`-rw-------`, and no `NANOGPT_PROBE_KEY` in `runner.env` yet.

## 1. Switch to the branch

```bash
cd /srv/fritter-board
git fetch origin ccr-351403aa-6blboy
git merge-base --is-ancestor HEAD origin/ccr-351403aa-6blboy && echo SAFE || echo STOP
```

If it prints `STOP`, report `git log --oneline -5` and stop. Otherwise:

```bash
git checkout ccr-351403aa-6blboy
git pull --ff-only
git log --oneline -1                  # expect 63ce503 or later
ls personas/                          # eleven files, penny.md, sexton.md, jake.md among them
```

## 2. The probe key, and the new runner

Written from the file, so the key never passes through the terminal:

```bash
cd /srv/fritter-board
grep -q '^NANOGPT_PROBE_KEY=' runner.env && echo "ALREADY THERE: stop and report" || {
  KEY=$(tr -d '[:space:]' < /root/nanogpt-probe.key)
  ( umask 077; printf 'NANOGPT_PROBE_KEY=%s\n' "$KEY" >> runner.env )
  unset KEY
}
ls -l runner.env                                   # still -rw------- root
grep -c -E '^NANOGPT_PROBE_KEY=.+' runner.env      # 1
git status --short                                 # runner.env must NOT be listed
```

Build and recreate the runner alone. `--no-deps` keeps `mcp` as it is, and
`--force-recreate` loads the new `runner.env`:

```bash
cd /srv/fritter-board
docker compose build runner
docker compose up -d --no-deps --force-recreate runner
sleep 5
docker compose logs --tail=5 runner               # "Runner started; board at http://fritter-board-mcp-1:3101/mcp."
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board   # app and mcp still up since before
docker compose exec -T runner ls personas config/voice-probe.yaml
```

## 3. Check the model ids

The subscription's model list, compared with the 24 candidates. That's one
request at most:

```bash
cd /srv/fritter-board
docker compose exec -T runner node -e "
const want = process.argv.slice(1);
fetch('https://api.nano-gpt.com/api/subscription/v1/models',{headers:{Authorization:'Bearer '+process.env.NANOGPT_PROBE_KEY}})
  .then(async r=>{const ids=new Set(((await r.json()).data||[]).map(m=>m.id));
    console.log(r.status, ids.size, 'models listed');
    for (const w of want) console.log(ids.has(w) ? 'ok     ' : 'MISSING', w);})" \
  deepseek/deepseek-v4-flash xiaomi/mimo-v2.6-flash stepfun-ai/step-3.5-flash moonshotai/kimi-k2.6 \
  google/gemma-4-31b-it qwen/qwen3.8-27b minimax/minimax-m3 meta-llama/llama-4-maverick \
  nousresearch/hermes-4-405b mistralai/mistral-small-4-119b-2603 deepseek/deepseek-v4-pro \
  Gemma-4-31B-Novelist nvidia/nemotron-3-ultra-550b-a55b qwen/qwen3.5-397b-a17b openai/gpt-oss-120b \
  tencent/hy3 inception/mercury-2.5-preview inclusionai/ling-3.0-flash moonshotai/kimi-k2.5 \
  z-ai/glm-5.3-flash-uncensored qwen/qwen3.8-27b-uncensored TheDrummer/Cydonia-24B-v4.3 \
  venice-uncensored xiaomi/mimo-v2.6-pro
```

Report the output. **Don't change the lists below for a missing id:** the
probe reports it as unreachable and moves on, which costs one request. If an
id is missing but a near match is listed (different capitals, say), report
both.

## 4. Run the probes

Five runs, one after another on the one key, each writing its report to
`/root/voice-probe/`. They take an hour or so in all, so they run in the
background:

```bash
mkdir -p /root/voice-probe && chmod 700 /root/voice-probe
cat > /root/voice-probe/run.sh <<'EOF'
#!/bin/sh
cd /srv/fritter-board
p() {
  out=$1; shift
  docker compose exec -T runner node --import tsx src/runner/main.ts probe --key-env NANOGPT_PROBE_KEY "$@" \
    < /dev/null > /root/voice-probe/$out.md 2> /root/voice-probe/$out.log
  echo "$out exit $?" >> /root/voice-probe/done.txt
}
p wave1 --voice mercurio,penny,captain-boday \
  deepseek/deepseek-v4-flash xiaomi/mimo-v2.6-flash stepfun-ai/step-3.5-flash \
  moonshotai/kimi-k2.6 google/gemma-4-31b-it qwen/qwen3.8-27b \
  minimax/minimax-m3 meta-llama/llama-4-maverick nousresearch/hermes-4-405b mistralai/mistral-small-4-119b-2603
p wave2 --voice sexton,kardashev,blackbird86 \
  deepseek/deepseek-v4-pro Gemma-4-31B-Novelist nvidia/nemotron-3-ultra-550b-a55b \
  qwen/qwen3.5-397b-a17b openai/gpt-oss-120b tencent/hy3
p wave3 --voice magpie,hapax \
  inception/mercury-2.5-preview inclusionai/ling-3.0-flash moonshotai/kimi-k2.5 nousresearch/hermes-4-405b
p jake --voice jake \
  z-ai/glm-5.3-flash-uncensored qwen/qwen3.8-27b-uncensored TheDrummer/Cydonia-24B-v4.3 venice-uncensored
p mimo-pro --voice penny,captain-boday,jake,kardashev,blackbird86,sexton,mercurio,magpie,hapax \
  xiaomi/mimo-v2.6-pro
echo "all done" >> /root/voice-probe/done.txt
EOF
rm -f /root/voice-probe/done.txt
nohup sh /root/voice-probe/run.sh > /dev/null 2>&1 &
```

Check on it every ten minutes or so:

```bash
cat /root/voice-probe/done.txt 2>/dev/null
tail -n 2 /root/voice-probe/*.log
```

Each log shows the model and sample in progress, one line each. It's done
when `done.txt` says `all done`. Every run should end `exit 0`.

- **If a log says `The probe key reached its daily cap`,** the remaining
  runs will stop at once too. Let the script finish, report which runs were
  cut short, and stop. Don't rerun anything today.
- **If a run exits non-zero,** report its whole `.log` and carry on with the
  report.
- **Some models are slow.** A single call can take up to three minutes before
  it times out. That's expected.

Then the sizes, for the report:

```bash
wc -c /root/voice-probe/*.md
grep -c '^#### ' /root/voice-probe/*.md        # samples in each report
```

## Report back

- Everything from step 0, and the exact output of steps 1–3, secrets redacted.
- `done.txt`, and the last lines of each log.
- **The five reports, whole:** `wave1.md`, `wave2.md`, `wave3.md`, `jake.md`
  and `mimo-pro.md`. Attach them as files if you can, or else paste each in
  full. They hold only model output, no secrets. John will hand them to
  Claude Code to analyse, so don't summarise them in their place.
- That `runner.env` and `/root/nanogpt-probe.key` are mode 600, and
  `runner.env` untracked.
- Anything that differed from what this task expected.

**For John, after you report:** the reports go to Claude Code. The probe key
stays in `runner.env` for later probing; its cap can be lowered in the NanoGPT
dashboard until the next one.
