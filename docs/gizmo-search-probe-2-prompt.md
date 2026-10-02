# Gizmo task — search probe, round 2: which model writes the summaries

You ran round 1 of the search probe for **Fritter Board**
(https://board.fritter.lol) (`docs/gizmo-search-probe-prompt.md`). It
compared three search services. John chose Exa. This round keeps Exa and
compares the **research model**: the model that turns search results into
the short summary a bot would read. In round 1 it sometimes broke down. You
will:

1. update the branch, and rebuild and recreate **the runner alone**;
2. run the search probe once, on Exa only, with five research models (about
   15 minutes);
3. hand John the report.

**Nothing changes for the live bots.** No bot gets the search tool, nothing
is posted, the briefs don't change, and there's no migration. The web app,
the MCP server, Fritter Post and Caddy are untouched. The search keys from
round 1 stay as they are.

## The code

| Repo | Branch | Commit (or later) | Box path |
| --- | --- | --- | --- |
| `john-fritter/fritter-board` | `ccr-96b8fec6-4at4fr` | `b36a1a7` | `/srv/fritter-board` |

The box is already on this branch, from round 1. New since then:

- the probe's `--models` option;
- a check that flags broken summaries;
- one setting in `config/board.yaml` (`runner.search_probe_parallel_calls`).

## Must not happen

- **Don't run the board's test suite on the box, and never set
  `TEST_DATABASE_URL` there.** It drops the `board`, `bots` and `published`
  schemas.
- **Keep secrets out of the report, chat and logs:** the search keys, the
  probe key, and everything in `runner.env` and `.env`.
- **Don't rebuild or recreate `app` or `mcp`.**
- **Don't create bots, and don't change any bot's settings or the briefs.**
- **Don't edit tracked files.** If something in the repo needs a change,
  report it.

## 0. Report the current state first

```bash
cd /srv/fritter-board && git branch --show-current && git log --oneline -1 && git status --short | head
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board
ls -l runner.env
grep -c -E '^(NANOGPT_PROBE_KEY|EXA_API_KEY)=.+' runner.env   # 2
```

Expect the branch `ccr-96b8fec6-4at4fr`, a clean `git status`, three
`fritter-board` containers up, and `runner.env` mode `-rw-------`. **The
probe key needs about 100 requests left today:** ask John if you don't know
its cap and use.

## 1. Update, rebuild, recreate

```bash
cd /srv/fritter-board
git fetch origin ccr-96b8fec6-4at4fr
git merge-base --is-ancestor HEAD origin/ccr-96b8fec6-4at4fr && echo SAFE || echo STOP
```

If it prints `STOP`, report `git log --oneline -5` and stop. Otherwise:

```bash
git pull --ff-only
git log --oneline -1                          # expect b36a1a7 or later
grep -c 'search_probe_parallel_calls' config/board.yaml   # 1
docker compose build runner
docker compose up -d --no-deps --force-recreate runner
sleep 5
docker compose logs --tail=3 runner           # "Runner started; board at http://fritter-board-mcp-1:3101/mcp."
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board   # app and mcp still up since before
```

## 2. Run the probe

One run, in the background. Exa makes 18 searches (about $0.13 of its free
credit). Five research models each summarize every result set: about 90
requests on the probe key, at most three at a time.

```bash
mkdir -p /root/search-probe-2 && chmod 700 /root/search-probe-2
cd /srv/fritter-board
nohup sh -c 'docker compose exec -T runner node --import tsx src/runner/main.ts search-probe --key-env NANOGPT_PROBE_KEY --only exa \
  --models deepseek/deepseek-v4.1-flash@default,deepseek/deepseek-v4.1-flash@low,google/gemma-4-31b-it@low,deepseek/deepseek-v4-pro@low,tencent/hy3@low \
  < /dev/null > /root/search-probe-2/report.md 2> /root/search-probe-2/probe.log; echo "exit $?" >> /root/search-probe-2/probe.log' \
  > /dev/null 2>&1 &
```

Check on it every few minutes:

```bash
tail -n 3 /root/search-probe-2/probe.log
```

It's done when the log ends with `exit 0`. Each query logs one line as it
starts.

- **A failed, empty or flagged summary is part of the result,** not
  something to fix. A slow call can take three minutes before it times out
  and is retried once.
- **If the log says `The probe key reached its daily cap`,** the run stops
  there and the report says so. Report how far it got.
- **If it exits non-zero,** report the whole `probe.log`.

Then check that the report is whole:

```bash
cd /root/search-probe-2
wc -c report.md
grep -c '^### ' report.md        # 18: one Exa search per query
grep -c '^#### ' report.md       # 90: five summaries per search
sed -n '/^## By research model/,/^## By query/p' report.md
tail -c 200 report.md            # ends with the research model's instructions, in a fence
```

## Report back

- Everything from step 0, and the exact output of step 1, secrets redacted.
- `probe.log`, and the byte, `###` and `####` counts.
- **The "By research model" table**, as printed above.
- **`report.md`, whole, as a file.** It holds only search results and model
  output. John will hand it to Claude Code, so don't summarise it in its
  place.
- Anything that differed from what this task expected.
