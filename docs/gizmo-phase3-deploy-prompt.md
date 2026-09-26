# Gizmo task — deploy Fritter Board phase 3 (the Fritter Post link)

Two repos, same branch name in both: **`claude/fritter-board-phase-three-wmh6tj`**.

| Repo | Commit (or later) | Box path (assumed; confirm) |
| --- | --- | --- |
| `john-fritter/fritter-post` | `5fa8c8f` | `/srv/fritter-post` |
| `john-fritter/fritter-board` | `6cd98b3` | `/srv/fritter-board` |

## What changed

Phase 3 of Fritter Board links discussion threads to Fritter Post articles.

**Fritter Post**
- New permanent page per piece: `/article/<id>`, where the id is
  `writer_pieces.id`. `/story/<ref>` still works and still means today's paper.
- Every piece page links "Discuss on the board" to `<BOARD_URL>/article/<id>`.
  The link only appears when the new env var `BOARD_URL` is set.
- **Migration 046** creates a schema `published` holding two views,
  `published.articles` and `published.article_sources`. They are the board's
  only way to read the paper. The board's role gets access to that schema and
  nothing in `public`. It must never be able to read `article_texts`.

**Fritter Board**
- `/article/<id>` opens the article's thread, or offers members the form to
  start one. Threads about an article show an article card at the top.
- **Migration 004** changes one index.
- Two new env vars: `FP_DATABASE_URL` and `FP_PUBLIC_URL`.

## Must not happen

- Do not run any Fritter Post pipeline stage by hand: no `collect`, `preprocess`,
  `prefilter`, `grouping`, `grouping-pass1`, `editor`, `fetch-text`, `write`,
  `publish` or `pipeline`.
- **Do not deploy while the daily pipeline is running.** It starts at 06:00
  America/Los_Angeles and takes about 15–20 minutes. Rebuilding the app
  container mid-run kills it. Stay out of the 05:45–06:45 Pacific window, and
  check first:
  ```bash
  cd /srv/fritter-post
  docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT id, status, started_at FROM pipeline_runs ORDER BY id DESC LIMIT 1"'
  ```
  If the latest row says `running` and started less than an hour ago, wait
  for it to finish. A `running` row older than that is a run that was killed.
  Note it in your report and carry on.
- Do not edit `config/*.yaml` on the box. The only env changes are the lines
  given below.
- **Do not set `TEST_DATABASE_URL` on the box, and do not run the board's test
  suite there.** Its integration tests drop and recreate the `board` and
  `published` schemas.
- Do not pick or change the board's public URL. If the board isn't deployed
  yet, do Part A only, then report back.
- Do not post, register or create threads on the board. John will test that.

## 0. Report the current state first

```bash
cd /srv/fritter-post && git log --oneline -1 && git status --short | head
docker ps --format '{{.Names}}\t{{.Status}}' | grep -i fritter
ls -d /srv/fritter-board 2>/dev/null && (cd /srv/fritter-board && git log --oneline -1 && grep -E '^(PUBLIC_URL|FP_PUBLIC_URL)=' .env)
cd /srv/fritter-post && docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT rolname FROM pg_roles WHERE rolname = '"'"'fritter_board'"'"'; SHOW server_version;"'
cd /srv/fritter-post && grep -E '^POSTGRES_USER=' .env
```

(Don't print passwords.) If the board directory, container or role doesn't
exist, the board isn't deployed. Do Part A, skip Part B, and report.

## Part A — Fritter Post

A1. **Make sure the switch drops nothing.** The branch was cut from `main` at
`4a4a876`. Whatever the box is on now must be contained in it:

```bash
cd /srv/fritter-post
git fetch origin claude/fritter-board-phase-three-wmh6tj
git merge-base --is-ancestor HEAD origin/claude/fritter-board-phase-three-wmh6tj && echo SAFE || echo STOP
```

If it prints `STOP`, don't switch. Report `git log --oneline -5` and stop there.

A2. Deploy:

```bash
git checkout claude/fritter-board-phase-three-wmh6tj
git pull --ff-only
git log --oneline -1                                        # expect 5fa8c8f or later
docker compose up -d --build
docker network connect seedbox_default fritter-post-app-1   # always: the site 502s without it
docker compose exec -T app npm run migrate                  # expect 046_published_articles.sql applied
docker compose exec -T app npm test                         # expect "All 39 test files passed."
```

A3. Check that the views return data and that the permanent page works:

```bash
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
  SELECT COUNT(*) AS articles FROM published.articles;
  SELECT id, published_on, ref, left(coalesce(headline, body), 60) AS lead
    FROM published.articles ORDER BY published_on DESC, rank LIMIT 5;
  SELECT COUNT(*) AS source_links FROM published.article_sources;"'
```

Take the first `id` and the latest paper's first `ref` from that output:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://post.fritter.lol/                  # 200
curl -s -o /dev/null -w '%{http_code}\n' https://post.fritter.lol/article/<id>      # 200
curl -s -o /dev/null -w '%{http_code}\n' https://post.fritter.lol/story/<ref>       # 200
curl -s -o /dev/null -w '%{http_code}\n' https://post.fritter.lol/article/999999999 # 404
```

`BOARD_URL` is still unset at this point, so no page should contain
"Discuss on the board" yet.

## Part B — Fritter Board (only if it's deployed)

B1. **Grant the board's role the `published` schema and nothing else.**
Replace `fritter_post` in the last statement if `POSTGRES_USER` is different;
it has to be the role that owns the views, which is the one that ran the
migration.

```bash
cd /srv/fritter-post
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' <<'SQL'
GRANT USAGE ON SCHEMA published TO fritter_board;
GRANT SELECT ON ALL TABLES IN SCHEMA published TO fritter_board;
ALTER DEFAULT PRIVILEGES FOR ROLE fritter_post IN SCHEMA published GRANT SELECT ON TABLES TO fritter_board;
SQL
```

Then prove the boundary. The first statement must succeed and the second must
fail with `permission denied for table article_texts`:

```bash
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SET ROLE fritter_board;
SELECT COUNT(*) FROM published.articles;
SELECT COUNT(*) FROM public.article_texts;
SQL
```

B2. Deploy the board. Run the same ancestor check first:

```bash
cd /srv/fritter-board
git fetch origin claude/fritter-board-phase-three-wmh6tj
git merge-base --is-ancestor HEAD origin/claude/fritter-board-phase-three-wmh6tj && echo SAFE || echo STOP
git checkout claude/fritter-board-phase-three-wmh6tj && git pull --ff-only
git log --oneline -1                                        # expect 6cd98b3 or later
```

Add two lines to `/srv/fritter-board/.env`. `FP_DATABASE_URL` is the **same
value as the existing `DATABASE_URL`**: same database, same role. Copy it; don't
retype the password.

```
FP_DATABASE_URL=<same as DATABASE_URL>
FP_PUBLIC_URL=https://post.fritter.lol
```

```bash
docker compose up -d --build
docker compose exec -T app npx tsx scripts/migrate.ts       # expect 004_fp_link.sql applied
docker ps --format '{{.Names}}\t{{.Networks}}' | grep fritter-board   # expect fritter-post_internal and seedbox_default
```

The board's compose file declares `seedbox_default` itself, so it doesn't need
the manual reconnect. If the network is missing anyway, run
`docker network connect seedbox_default fritter-board-app-1`.

B3. Board checks. `<board>` is the board's `PUBLIC_URL` and `<id>` is from A3.

```bash
curl -s -o /dev/null -w '%{http_code}\n' <board>/                      # 200
curl -s <board>/article/<id> | grep -c 'fp-card'                       # 1
curl -s <board>/article/<id> | grep -o 'https://post.fritter.lol/article/[0-9]*' | head -1
curl -s -o /dev/null -w '%{http_code}\n' <board>/article/999999999     # 404
docker compose logs --tail=50 app | grep -i error                      # expect nothing new
```

B4. **Turn on the link from the paper.** Only do this after B3 passes. Add
this to `/srv/fritter-post/.env`, where `<board>` is the board's `PUBLIC_URL`
with no trailing slash:

```
BOARD_URL=<board>
```

```bash
cd /srv/fritter-post
docker compose up -d --force-recreate app
docker network connect seedbox_default fritter-post-app-1   # again: recreating drops it
curl -s https://post.fritter.lol/article/<id> | grep -o 'href="[^"]*/article/[0-9]*">Discuss on the board'
```

The last command should print the board's `/article/<id>` link.

## Report back

- Everything from step 0.
- Exact output of A1, A2 (migrate and test lines), A3, and B1 through B4, or
  where you stopped and why.
- One real article id, and its board URL and paper URL, so John can click
  through and start the first thread himself.
- Anything that differed from what this task expected.
