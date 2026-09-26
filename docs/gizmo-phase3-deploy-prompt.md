# Gizmo task — first deploy of Fritter Board at board.fritter.lol, and the Fritter Post side of its link

This is new work, so start with the introduction. The task has three parts:

- **Part A:** update Fritter Post, which you already run.
- **Part B:** deploy **Fritter Board** for the first time, at
  **https://board.fritter.lol**.
- **Part C:** link the two.

## What Fritter Board is

Fritter Board is John's new, small, text-only discussion board: an idealized
2006 forum. It's for talking about Fritter Post articles and whatever else
comes up. It will eventually have a cast of persona bots as members, but not
yet: bots come in a later phase and will reach the board through an MCP
server. What exists now is a working human forum:

- invite-only registration and one admin (John);
- categories, boards and threads, and posts written in BBCode;
- private messages, search and moderation tools;
- a members-only "Back Room";
- **new in this deploy:** threads linked to Fritter Post articles.

How it runs:

- **Repo:** `john-fritter/fritter-board`. Build notes are in `README.md`,
  conventions in `CLAUDE.md`, and the full plan in `docs/spec.md`.
- **Stack:** TypeScript on Node 22. Hono serves server-rendered HTML and ships
  **zero client JavaScript** (the CSP forbids scripts). There is no build step:
  the container runs `npx tsx src/server.ts` on port **3100**.
- **Container:** `fritter-board-app-1`, from the repo's own
  `docker-compose.yml`. It has **no database of its own**. It uses **Fritter
  Post's Postgres**, in its own schema called `board`, as its own role called
  `fritter_board`. To reach Postgres it joins Fritter Post's internal network
  (`fritter-post_internal`), and to be reachable by Caddy it joins
  `seedbox_default`. Both networks are declared in its compose file.
- **Reading the paper:** the board reads Fritter Post's published articles
  read-only, through two views in a schema called `published`. Part A creates
  them. Its role is granted that schema and **nothing else of Fritter
  Post's**. In particular, it must never be able to read `article_texts`.
- **Ops is yours from here on,** as it is for Fritter Post: deployment, Caddy,
  backups, keeping it up.

## The code

Both repos use the same branch name: **`claude/fritter-board-phase-three-wmh6tj`**.

| Repo | Commit (or later) | Box path |
| --- | --- | --- |
| `john-fritter/fritter-post` | `5fa8c8f` | `/srv/fritter-post` (existing) |
| `john-fritter/fritter-board` | `6cd98b3` | `/srv/fritter-board` (new; clone it next to Fritter Post if `/srv` isn't where Fritter Post lives) |

What changed in Fritter Post:

- **Permanent page per piece:** `/article/<id>`, where the id is
  `writer_pieces.id`. `/story/<ref>` still works and still means today's paper.
- **"Discuss on the board":** every piece page links to
  `<BOARD_URL>/article/<id>`. The link only appears once the new env var
  `BOARD_URL` is set, which is Part C.
- **Migration 046:** creates the `published` schema and its two views,
  `published.articles` and `published.article_sources`.

## Must not happen

- **Do not run any Fritter Post pipeline stage by hand:** no `collect`,
  `preprocess`, `prefilter`, `grouping`, `grouping-pass1`, `editor`,
  `fetch-text`, `write`, `publish` or `pipeline`.
- **Do not deploy while the daily pipeline is running.** It starts at 06:00
  America/Los_Angeles and takes about 15–20 minutes. Rebuilding Fritter Post's
  app container mid-run kills it. Stay out of the 05:45–06:45 Pacific window,
  and check first:
  ```bash
  cd /srv/fritter-post
  docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT id, status, started_at FROM pipeline_runs ORDER BY id DESC LIMIT 1"'
  ```
  If the latest row says `running` and started less than an hour ago, wait for
  it to finish. A `running` row older than that is a run that was killed. Note
  it in your report and carry on.
- **Don't change config you weren't asked to change.**
  - Don't edit `config/*.yaml` in either repo.
  - The only env changes are the ones below. Don't commit any env file.
  - Don't edit tracked files on the box. If something in a repo has to change
    (a network name, say), report it and the change will be made on the branch.
- **Don't run the board's test suite on the box, and never set
  `TEST_DATABASE_URL` there.** Its integration tests drop and recreate the
  `board` and `published` schemas.
- **Don't post, invite anyone or create threads on the board.** That's for John.
- **Keep secrets out of the report.** The new database password and John's
  temporary admin password go in the files named below, never in the report.

## 0. Report the current state first

```bash
cd /srv/fritter-post && git log --oneline -1 && git status --short | head
grep -E '^POSTGRES_(USER|DB)=' /srv/fritter-post/.env
docker ps --format '{{.Names}}\t{{.Networks}}' | grep -iE 'fritter|caddy'
docker network ls | grep -E 'fritter|seedbox'
dig +short post.fritter.lol; dig +short board.fritter.lol
```

Also find out:

- how Caddy runs (a container or systemd) and where its config file is: the
  file that holds the `post.fritter.lol` site block;
- how Fritter Post's database is backed up today, if it is.

## Part A — Fritter Post

A1. **Make sure switching branches drops nothing.** The branch was cut from
`main` at `4a4a876`. Whatever the box is on now must be contained in it:

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

Use the first `id` from that output as `<id>` below, and the ref of today's
first piece as `<ref>`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://post.fritter.lol/                  # 200
curl -s -o /dev/null -w '%{http_code}\n' https://post.fritter.lol/article/<id>      # 200
curl -s -o /dev/null -w '%{http_code}\n' https://post.fritter.lol/story/<ref>       # 200
curl -s -o /dev/null -w '%{http_code}\n' https://post.fritter.lol/article/999999999 # 404
```

No page should contain "Discuss on the board" yet.

## Part B — Fritter Board, first deploy

B1. **DNS.** `board.fritter.lol` has to resolve to the same address as
`post.fritter.lol` (step 0's `dig`). If it doesn't, **stop Part B here** and
report it. The DNS record is John's to add. Part A stands on its own.

B2. **Clone:**

```bash
cd /srv
git clone -b claude/fritter-board-phase-three-wmh6tj https://github.com/john-fritter/fritter-board.git
cd fritter-board && git log --oneline -1                    # expect 6cd98b3 or later
```

Use the same method and credentials you use for Fritter Post. If the clone is
refused, report it: the repo may need a deploy key.

B3. **Network name.** The board's `docker-compose.yml` joins
`fritter-post_internal`, which assumes Fritter Post's compose project is named
`fritter-post`. Check it against `docker network ls` from step 0. If Fritter
Post's internal network has a different name, stop and report it. Don't edit
the compose file.

B4. **Database role.** The board gets its own login role. It can create its
own `board` schema, and it can read Fritter Post's `published` views and
nothing else.

Generate the password on the box. Keep it URL-safe, because it goes into a
connection string:

```bash
BOARD_DB_PW=$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-32)
cd /srv/fritter-post
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -v pw="'"$BOARD_DB_PW"'"' <<'SQL'
CREATE ROLE fritter_board LOGIN PASSWORD :'pw';
GRANT CREATE ON DATABASE fritter_post TO fritter_board;
GRANT USAGE ON SCHEMA published TO fritter_board;
GRANT SELECT ON ALL TABLES IN SCHEMA published TO fritter_board;
ALTER DEFAULT PRIVILEGES FOR ROLE fritter_post IN SCHEMA published GRANT SELECT ON TABLES TO fritter_board;
SQL
```

The SQL uses `fritter_post` twice: in `GRANT CREATE ON DATABASE fritter_post`
it is `POSTGRES_DB`, and in `FOR ROLE fritter_post` it is `POSTGRES_USER`,
the role that ran migration 046 and owns the views. If step 0 showed different
values, substitute them.

Now prove the boundary. The first `SELECT` must return a number. The second
must fail with `permission denied for table article_texts`:

```bash
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SET ROLE fritter_board;
SELECT COUNT(*) FROM published.articles;
SELECT COUNT(*) FROM public.article_texts;
SQL
```

B5. **The board's `.env`.** Write it in the same shell, so `$BOARD_DB_PW` is
still set. Substitute the database name if it differs.

```bash
cd /srv/fritter-board
umask 077
cat > .env <<EOF
DATABASE_URL=postgresql://fritter_board:${BOARD_DB_PW}@postgres:5432/fritter_post
FP_DATABASE_URL=postgresql://fritter_board:${BOARD_DB_PW}@postgres:5432/fritter_post
PUBLIC_URL=https://board.fritter.lol
FP_PUBLIC_URL=https://post.fritter.lol
PORT=3100
EOF
chmod 600 .env
```

`DATABASE_URL` and `FP_DATABASE_URL` are deliberately the same: same database,
same role. The board opens the second one as a separate, read-only
connection. An `https://` `PUBLIC_URL` also turns on secure cookies, and the
board rejects form posts whose Origin doesn't match it, so it must be exactly
`https://board.fritter.lol`.

B6. **Build, migrate, create John's admin account:**

```bash
docker compose up -d --build
docker compose exec -T app npx tsx scripts/migrate.ts
docker compose logs --tail=20 app                           # expect "Fritter Board listening on :3100"
docker ps --format '{{.Names}}\t{{.Networks}}' | grep fritter-board
```

- `migrate.ts` should report applying `001_board_schema.sql` through
  `004_fp_link.sql`.
- The last command should list both `fritter-post_internal` and
  `seedbox_default`. If `seedbox_default` is missing, run
  `docker network connect seedbox_default fritter-board-app-1`.

John's account is created with a temporary password. John changes it himself
at Settings after he first logs in:

```bash
ADMIN_PW=$(openssl rand -base64 18 | tr -d '/+=')
docker compose exec -T -e ADMIN_PASSWORD="$ADMIN_PW" app npx tsx scripts/create-admin.ts John
( umask 077; printf 'Fritter Board admin\nusername: John\ntemporary password: %s\nChange it at https://board.fritter.lol/settings after logging in.\n' "$ADMIN_PW" > /root/fritter-board-admin.txt )
```

Tell John the password is in `/root/fritter-board-admin.txt`, or give it to him
directly, but not in the report.

B7. **Caddy.** Back up the config file you found in step 0. Then add a site
block for the board beside the one for `post.fritter.lol`, following that
block's conventions (encoding, logging, headers):

```
board.fritter.lol {
	reverse_proxy fritter-board-app-1:3100
}
```

Use `reverse_proxy`, not `handle_path`: the board serves from `/`. Validate and
reload the way this box's Caddy is run, for example `caddy validate` then
`caddy reload` inside the Caddy container, or `systemctl reload caddy`. Caddy
gets the TLS certificate on the first request. **Don't remove or reorder
anything else in the file.**

B8. **Checks.** `<id>` is from A3.

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://board.fritter.lol/                   # 200
curl -sI https://board.fritter.lol/ | grep -i content-security-policy                 # default-src 'none'; …
curl -s https://board.fritter.lol/ | grep -o '<title>[^<]*'                           # Fritter Board
curl -s -o /dev/null -w '%{http_code}\n' https://board.fritter.lol/b/back-room        # 404 (hidden from visitors)
curl -s https://board.fritter.lol/article/<id> | grep -c 'fp-card'                    # 1
curl -s https://board.fritter.lol/article/<id> | grep -o 'https://post.fritter.lol/article/[0-9]*' | head -1
curl -s -o /dev/null -w '%{http_code}\n' https://board.fritter.lol/article/999999999  # 404
curl -s -o /dev/null -w '%{http_code}\n' https://post.fritter.lol/                    # still 200
cd /srv/fritter-board && docker compose logs --tail=50 app | grep -i error            # expect nothing
```

B9. **Backups.** The board lives inside Fritter Post's database, so a
whole-database dump already covers it. Report whether the existing backup is a
whole-database dump or is limited to particular schemas or tables. Don't
change it; just say what it covers.

## Part C — turn on the link from the paper

Only do this after B8 passes. Add this line to `/srv/fritter-post/.env`:

```
BOARD_URL=https://board.fritter.lol
```

```bash
cd /srv/fritter-post
docker compose up -d --force-recreate app
docker network connect seedbox_default fritter-post-app-1   # again: recreating drops it
curl -s https://post.fritter.lol/article/<id> | grep -o 'href="[^"]*/article/[0-9]*">Discuss on the board'
curl -s -o /dev/null -w '%{http_code}\n' https://post.fritter.lol/                  # 200
```

The `grep` should print `href="https://board.fritter.lol/article/<id>">Discuss on the board`.

## Report back

- Everything from step 0, including how Caddy runs, the config file path, and
  what the backups cover.
- The exact output of A1–A3, B1–B9 and C, or where you stopped and why.
- The Caddy site block you added, as written.
- One real article id with its paper URL and board URL, so John can click
  through and start the first thread himself.
- Anything that differed from what this task expected.
- For John: where his temporary admin password is, and a reminder to change
  it at Settings, then post the draft site rules (`docs/site-rules.md` in the
  board repo) as a sticky thread in Site Business.
