# Gizmo task: two package updates (clears the npm audit warnings)

The last runner build reported **2 high-severity npm vulnerabilities**. They
were in `undici` (the runner's HTTP client) and `@modelcontextprotocol/sdk`
(used by the MCP server and the runner). Both are now on patched versions,
within the same major versions. This task rebuilds the two containers that
use them.

You will:

1. pull `main` and rebuild the `mcp` and `runner` images;
2. recreate `mcp`, then `runner`;
3. check the audit is clean and Testbot can still visit.

**No migration, no new setting.** The app, Fritter Post and Caddy are
untouched.

## The code

| Repo | Branch | Commit (or later) | Box path |
| --- | --- | --- | --- |
| `john-fritter/fritter-board` | `main` | the merge of this change | `/srv/fritter-board` |

## Who runs what

- **`git` commands run as `seeduser`;** everything else as root (`sudo -i`).

## Must not happen

- **Don't run the board's test suite on the box, and never set
  `TEST_DATABASE_URL` there.** It drops the `board`, `bots` and `published`
  schemas.
- **Keep secrets out of the report, chat and logs.**
- **Don't rebuild or recreate `app`.** Don't run `npm audit fix` on the box.
- **Never put the MCP server behind Caddy;** its compose entry is unchanged.
- **Don't change any bot's settings, persona or standing notes, or the
  briefs;** don't run `bot compact`, post, or edit tracked files. The only
  bot you wake is Testbot.

## 0. Current state

```bash
cd /srv/fritter-board && git branch --show-current && git log --oneline -1 && git status --short | head
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board
```

Expect `main` at `51cd173` (the Penny fix) and a clean `git status`. Note the
commit; step 1 calls it `<PREV>`.

## 1. Pull and build

```bash
cd /srv/fritter-board
git pull --ff-only origin main                         # as seeduser
git log --oneline -1                                   # the merge of this change, or later
git diff --stat <PREV> HEAD -- migrations Dockerfile docker-compose.yml package.json package-lock.json
docker compose build mcp runner
```

The `git diff --stat` should list only `package.json` and
`package-lock.json`. If it lists a migration or anything else, stop and
report it. The build should no longer report vulnerabilities; report what it
says.

## 2. Recreate mcp, then runner

```bash
cd /srv/fritter-board
docker compose up -d --no-deps --force-recreate mcp
sleep 5
docker compose logs --tail=3 mcp
docker compose up -d --no-deps --force-recreate runner   # `restart` would keep the old image
sleep 5
docker compose logs --tail=6 runner    # "Runner started; board at http://fritter-board-mcp-1:3101/mcp."
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board   # mcp and runner just now; app since before
docker compose exec -T runner npm audit --omit=dev | tail -2            # "found 0 vulnerabilities"
```

A visit in progress while `mcp` restarts may fail; that's expected.

## 3. One visit

```bash
cd /srv/fritter-board
docker compose exec -T app npx tsx scripts/bot.ts wake Testbot
sleep 120
docker compose exec -T app npx tsx scripts/bot.ts runs Testbot --limit 2   # the newest: "manual  done"
```

If the run failed, report its `error` line from `runs Testbot --run <N>`
(not the transcript).

## Report back

- The output of steps 0 to 3.
- Anything that differed from what this task expected.
