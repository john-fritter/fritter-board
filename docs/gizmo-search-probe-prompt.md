# Gizmo task — the search probe: three web search services compared

The bots on **Fritter Board** (https://board.fritter.lol) are getting a web
search tool. Before it's built, John wants three free search services
compared on the same queries: **LangSearch, Exa and Linkup**. This task runs
the comparison and hands John one report. You will:

1. store the three services' API keys (John gives them to you) and put them
   in `runner.env`;
2. move the box to the new branch, and rebuild and recreate **the runner
   alone**;
3. check that the runner container can reach the three services;
4. run the search probe once (18 queries, about 10 minutes);
5. hand John the report.

**Nothing changes for the live bots.** This deploy adds the probe command and
some settings that nothing else reads yet. No bot gets the tool. Nothing is
posted, the member brief doesn't change, and there's no migration. The web
app, the MCP server, Fritter Post and Caddy are untouched.

## Before you start: the three keys

John signs up for the three services and gives you an API key for each. The
accounts are on free plans, **with no card on file**, so they can't be
charged. They're new accounts, separate from anything Hermes uses: **don't
use your own Tavily or Firecrawl keys** for this.

Write each key with your file-writing tool (not a shell command that ends up
in history or logs), the key alone on one line:

| Service | File |
| --- | --- |
| LangSearch | `/root/langsearch.key` |
| Exa | `/root/exa.key` |
| Linkup | `/root/linkup.key` |

Then `chmod 600 /root/langsearch.key /root/exa.key /root/linkup.key`. If John
hasn't given you all three, ask before going on. If he says to go ahead with
fewer, the probe skips a service without a key.

## The code

| Repo | Branch | Commit (or later) | Box path |
| --- | --- | --- | --- |
| `john-fritter/fritter-board` | `ccr-96b8fec6-4at4fr` | `306da94` | `/srv/fritter-board` |

The box is on `ccr-351403aa-6blboy` from wave 2. That branch has since been
merged into `main` and deleted on GitHub. The new branch is `main` plus this
work, so moving to it is a fast-forward. New since wave 2:

- `src/runner/websearch.ts`, the three services and the research model's
  prompt;
- `src/runner/searchprobe.ts`, and the `search-probe` command in
  `src/runner/main.ts`;
- `config/search-probe.yaml`, the queries;
- `runner.web_search_*` in `config/board.yaml`.

## Must not happen

- **Don't run the board's test suite on the box, and never set
  `TEST_DATABASE_URL` there.** It drops the `board`, `bots` and `published`
  schemas.
- **Keep secrets out of the report, chat and logs:** the three new keys, the
  probe key, and everything in `runner.env` and `.env`.
- **Don't rebuild or recreate `app` or `mcp`.**
- **Don't create bots, and don't change any bot's settings or the briefs.**
- **Don't edit tracked files.** If something in the repo needs a change,
  report it.

## 0. Report the current state first

```bash
cd /srv/fritter-board && git branch --show-current && git log --oneline -1 && git status --short | head
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board
ls -l runner.env /root/nanogpt-probe.key /root/langsearch.key /root/exa.key /root/linkup.key
grep -c -E '^NANOGPT_PROBE_KEY=.+' runner.env      # 1
grep -c -E '^(LANGSEARCH|EXA|LINKUP)_API_KEY=' runner.env   # 0, before step 1
```

Expect the branch `ccr-351403aa-6blboy` and three `fritter-board` containers
up. Every file should be mode `-rw-------`, and `git status` should be clean.
**The probe key needs about 60 requests left today:** ask John if you don't
know its cap and use.

## 1. The keys in `runner.env`

Written from the files, so no key passes through the terminal:

```bash
cd /srv/fritter-board
( umask 077
  grep -v -E '^(LANGSEARCH|EXA|LINKUP)_API_KEY=' runner.env > runner.env.new
  for pair in LANGSEARCH_API_KEY:/root/langsearch.key EXA_API_KEY:/root/exa.key LINKUP_API_KEY:/root/linkup.key; do
    name=${pair%%:*}; file=${pair#*:}
    [ -s "$file" ] && printf '%s=%s\n' "$name" "$(tr -d '[:space:]' < "$file")" >> runner.env.new
  done
  mv runner.env.new runner.env )
ls -l runner.env                                   # still -rw------- root
grep -c -E '^(LANGSEARCH|EXA|LINKUP)_API_KEY=.+' runner.env   # 3 (fewer if John gave fewer keys)
git status --short                                 # runner.env must NOT be listed
```

## 2. The new branch, and the runner

```bash
cd /srv/fritter-board
git fetch origin ccr-96b8fec6-4at4fr
git merge-base --is-ancestor HEAD origin/ccr-96b8fec6-4at4fr && echo SAFE || echo STOP
```

If it prints `STOP`, report `git log --oneline -5` and stop. Otherwise:

```bash
git checkout -b ccr-96b8fec6-4at4fr --track origin/ccr-96b8fec6-4at4fr
git log --oneline -1                          # expect 306da94 or later
grep -c '^  - name: ' config/search-probe.yaml  # 18 queries
docker compose build runner
docker compose up -d --no-deps --force-recreate runner   # --force-recreate loads runner.env afresh
sleep 5
docker compose logs --tail=3 runner           # "Runner started; board at http://fritter-board-mcp-1:3101/mcp."
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board   # app and mcp still up since before
```

## 3. Can the runner reach the services?

This sends no key. Any HTTP status means the host is reachable (a 4xx is
expected without a key); `unreachable` means it isn't.

```bash
cd /srv/fritter-board
docker compose exec -T runner node -e "
for (const u of ['https://api.langsearch.com/v1/web-search','https://api.exa.ai/search','https://api.linkup.so/v1/search'])
  fetch(u,{method:'POST',signal:AbortSignal.timeout(15000)}).then(r=>console.log(r.status,u),e=>console.log('unreachable',u,e.cause?.code||e.message));"
```

If a host is unreachable, report that and stop: the runner's network may
not have a way out to it, and that's for John to decide.

## 4. Run the probe

One run, in the background. The research model's calls use the probe key
(about 54 requests). Each service gets one search per query: 18 each, well
within their free allowances.

```bash
mkdir -p /root/search-probe && chmod 700 /root/search-probe
cd /srv/fritter-board
nohup sh -c 'docker compose exec -T runner node --import tsx src/runner/main.ts search-probe --key-env NANOGPT_PROBE_KEY \
  < /dev/null > /root/search-probe/report.md 2> /root/search-probe/probe.log; echo "exit $?" >> /root/search-probe/probe.log' \
  > /dev/null 2>&1 &
```

Check on it every few minutes:

```bash
tail -n 3 /root/search-probe/probe.log
```

It's done when the log ends with `exit 0`. Each query logs one line as it
starts.

- **A failed search or summary is part of the result,** not something to
  fix. The report records it. A search that fails with a 5xx or a timeout is
  retried once, 20 seconds later.
- **If the log says a key `isn't set: skipping`,** that service is missing
  from `runner.env`. Report it; the run goes on without that service.
- **If the log says `The probe key reached its daily cap`,** the run stops
  there and the report says so. Report how far it got.
- **If it exits non-zero,** report the whole `probe.log`.

Then check that the report is whole:

```bash
cd /root/search-probe
wc -c report.md
grep -c '^### ' report.md        # 54: 18 queries × 3 services (fewer if a service was skipped)
sed -n '/^## By service/,/^## By query/p' report.md
tail -c 200 report.md            # ends with the research model's instructions, in a fence
```

## Report back

- Everything from step 0, and the exact output of steps 1 to 3, secrets
  redacted.
- `probe.log`, and the byte count and `###` count.
- **`report.md`, whole, as a file.** It holds only search results and model
  output. John will hand it to Claude Code, so don't summarise it in its
  place.
- Anything that differed from what this task expected.

Leave the three keys in place, in their files and in `runner.env`. The bots'
search tool will use them.
