# Gizmo task — deploy the admin's Markdown downloads

**Fritter Board** (https://board.fritter.lol) gets one new feature: the admin
can download a thread, the whole archive, or everything about one bot as a
Markdown file, after a page that shows the file's size in tokens. The pages
are under `/admin/export/`, and like the rest of `/admin` they don't exist
for anyone but the admin (a 404).

This feature was deployed once before (2026-10-10, from the branch
`ccr-3b7f93f2-5krhst`) but never merged into `main`, so the next deploy from
`main` took it away again. This branch is today's `main` with it merged back in.

You will:

1. check the box is on `main` at `0da1415` (the npm patch deploy);
2. move to the new branch;
3. rebuild and recreate **the app only**;
4. check the new pages are hidden from visitors, and the app runs the new code.

**There is no migration** and no new setting in `.env` or `runner.env`. **The
MCP server, the runner, Fritter Post and Caddy are untouched**: don't rebuild
or recreate them.

## The code

| Repo | Branch | Commit (or later) | Box path |
| --- | --- | --- | --- |
| `john-fritter/fritter-board` | `claude/project-thread-o9bru0` | the commit adding this task | `/srv/fritter-board` |

The branch starts from `main` at `0da1415`.

## Who runs what

- **`git` commands run as `seeduser`:** root's SSH host-key check fails.
- **`docker compose` commands run with `sudo`.**

## Must not happen

- **Don't run the board's test suite on the box, and never set
  `TEST_DATABASE_URL` there.** It drops the `board`, `bots` and `published`
  schemas.
- **Keep secrets out of the report, chat and logs:** everything in
  `runner.env` and `.env`, and bot tokens.
- **Don't rebuild or recreate the `mcp` or `runner` containers.**
- **Don't post on the board yourself, and don't edit tracked files.** If
  something in the repo needs a change, report it.

## 0. Report the current state first

```bash
cd /srv/fritter-board && git branch --show-current && git log --oneline -1 && git status --short | head
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board
```

Expect the branch `main` at `0da1415`, a clean `git status`, and three
`fritter-board` containers up (`app`, `mcp`, `runner`). If the box is on
anything else, **stop and report.**

## 1. Move to the new branch

```bash
cd /srv/fritter-board
git fetch origin claude/project-thread-o9bru0          # as seeduser
git merge-base --is-ancestor HEAD origin/claude/project-thread-o9bru0 && echo SAFE || echo STOP
```

If it prints `STOP`, report `git log --oneline -5` and stop. Otherwise:

```bash
cd /srv/fritter-board
git checkout -b claude/project-thread-o9bru0 --track origin/claude/project-thread-o9bru0
git log --oneline -1                                   # the commit adding this task, or later
git diff --stat 0da1415 HEAD -- migrations Dockerfile docker-compose.yml package.json package-lock.json
grep -n "^export:" config/board.yaml                   # one line: the new section
```

The `git diff --stat` should print **nothing**. If it lists any file,
**stop and report it**: that needs a different deploy.

## 2. Rebuild and recreate the app

```bash
cd /srv/fritter-board
sudo docker compose build app
sudo docker compose up -d --no-deps --force-recreate app      # a few seconds' blip for the web app
sleep 5
sudo docker compose logs --tail=3 app       # "Fritter Board listening on :3100"
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board   # app up just now; mcp and runner as before
```

## 3. Check it

The new pages are a 404 to a visitor, like the rest of `/admin`:

```bash
for p in /admin/export/archive /admin/export/archive/download /admin/export/thread/1 /admin/export/bot/Testbot/download; do
  printf '%s ' "$p"; curl -s -o /dev/null -w '%{http_code}\n' "https://board.fritter.lol$p"
done
curl -s -o /dev/null -w '%{http_code}\n' https://board.fritter.lol/     # 200: the board itself is fine
```

Expect `404` for each of the four, then `200`.

The app has the new code:

```bash
cd /srv/fritter-board
sudo docker compose exec -T app grep -c "registerExportRoutes" src/app.tsx   # 2
sudo docker compose exec -T app ls src/export src/forum/export.ts src/botadmin/export.ts
```

## Report back

- Everything from step 0, and the exact output of steps 1 to 3.
- Anything that differed from what this task expected.

John will try the downloads himself, logged in as the admin; you don't need
to.
