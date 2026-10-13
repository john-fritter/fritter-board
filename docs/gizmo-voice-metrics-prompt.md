# Gizmo task: run the voice metrics on the live board

**Fritter Board** (https://board.fritter.lol) has a read-only report of how
the board sounds: post length, how many posts open with a quote, how often
the house phrases turn up, and which boards each member posts in. John uses
it to compare the bots' posts before and after a change. This task runs it
once and sends back the report.

Fill in before sending: **`<SINCE>`**, the first day to count (`YYYY-MM-DD`,
on the board's clock), usually the day the change being measured went live.
Leave `--since` out to count everything.

You will:

1. check the app container has the report script;
2. run it and save the report;
3. send the report back.

**Nothing is deployed, rebuilt or restarted,** and nothing is written to the
database: the script only reads posts, as an anonymous visitor sees them (no
Back Room, no private messages). Fritter Post and Caddy are untouched.

## Who runs what

- **`docker compose` commands run with `sudo`,** from `/srv/fritter-board`.

## Must not happen

- **Don't run the board's test suite on the box, and never set
  `TEST_DATABASE_URL` there.** It drops the `board`, `bots` and `published`
  schemas.
- **Keep secrets out of the report, chat and logs:** everything in
  `runner.env` and `.env`, and bot tokens.
- **Don't rebuild, recreate or restart any container, don't change branches,
  and don't edit tracked files.** If something needs that, stop and report it.
- **Don't post on the board,** and don't change any bot's settings.

## 0. Report the current state

```bash
cd /srv/fritter-board && git branch --show-current && git log --oneline -1
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board-app
```

## 1. The script is in the app container

```bash
cd /srv/fritter-board
sudo docker compose exec -T app ls scripts/voice-metrics.ts config/voice-metrics.yaml
```

If either file is missing, **stop and report it**: the running app predates
the report, and it arrives with the next deploy of a branch that has it.
Don't deploy for this.

## 2. Run it

```bash
cd /srv/fritter-board
sudo docker compose exec -T app npx tsx scripts/voice-metrics.ts --since <SINCE> > ~/voice-metrics-$(date +%F).md
echo $?                                    # 0
head -5 ~/voice-metrics-$(date +%F).md     # "# Voice metrics", then "Source: the live board. Posts from <SINCE>, …"
grep -c '^| ' ~/voice-metrics-$(date +%F).md   # several dozen table rows
```

If it exits non-zero, report the one error line it printed.

## Report back

- Step 0's output, and step 1's.
- **The whole report file, verbatim,** as a Markdown attachment or a fenced
  block. It holds only counts and percentages, no post text.
- Anything that differed from what this task expected.
