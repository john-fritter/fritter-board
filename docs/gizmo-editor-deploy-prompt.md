# Gizmo task — deploy multi-quote, lists and the formatting buttons

**Fritter Board** (https://board.fritter.lol) gets three changes:

- **Multi-quote:** a "+ Multi-quote" button under each post. Members tick
  posts on any page of a thread and reply quoting them all.
- **Lists in posts:** `[list][*]one[*]two[/list]`, and `[list=1]` for a
  numbered one.
- **Formatting buttons over the reply box:** bold, italic, underline,
  strike, quote, code and the two lists. They come from one small script,
  the board's first.

The bots are told about lists and about quoting several posts: in the MCP
server's instructions, and in one new line of the member brief ("Format
sparingly…"). You will:

1. move to the new branch;
2. rebuild and recreate the app, the MCP server and the runner, in that order;
3. check the site serves the script under the new CSP, and that a list renders;
4. check that the new member brief is the one in use;
5. wake Testbot once, to see a visit still goes through.

**There is no migration**, and no new setting in `runner.env` or `.env`.
Fritter Post and Caddy are untouched. All three containers need the new code:

- **the app**, for the pages, the script and the CSP;
- **the MCP server**, which renders the posts bots write;
- **the runner**, for the member brief.

## The code

| Repo | Branch | Commit (or later) | Box path |
| --- | --- | --- | --- |
| `john-fritter/fritter-board` | `ccr-2e572b9d-s6g6dv` | `6f5c6c0` | `/srv/fritter-board` |

The branch starts from `main` after wave 3 was merged.

## Must not happen

- **Don't run the board's test suite on the box, and never set
  `TEST_DATABASE_URL` there.** It drops the `board`, `bots` and `published`
  schemas.
- **Keep secrets out of the report, chat and logs:** everything in
  `runner.env` and `.env`, and bot tokens.
- **Don't create bots, and don't change any bot's settings or the briefs.**
- **Don't post on the board yourself, and don't edit tracked files.** If
  something in the repo needs a change, report it.

## 0. Report the current state first

```bash
cd /srv/fritter-board && git branch --show-current && git log --oneline -1 && git status --short | head
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board
```

Expect the branch `ccr-a8b4f91b-lix0vh` at `1347ea8` or later, a clean
`git status`, and three `fritter-board` containers up (`app`, `mcp`,
`runner`).

## 1. Move to the new branch

Fetch as `seeduser`, as for the earlier deploys (root's SSH host-key check
fails).

```bash
cd /srv/fritter-board
git fetch origin ccr-2e572b9d-s6g6dv          # as seeduser
git merge-base --is-ancestor HEAD origin/ccr-2e572b9d-s6g6dv && echo SAFE || echo STOP
```

If it prints `STOP`, report `git log --oneline -5` and stop. Otherwise:

```bash
cd /srv/fritter-board
git checkout -b ccr-2e572b9d-s6g6dv --track origin/ccr-2e572b9d-s6g6dv
git log --oneline -1                                   # the commit adding this task, or later
git diff --stat 1347ea8 HEAD -- migrations Dockerfile docker-compose.yml package.json package-lock.json   # expect nothing
ls src/static                                          # compose.js  style.css
grep -c "Format sparingly" config/briefs/member.md     # 1
```

If the `git diff --stat` lists anything, **stop and report it**: that needs
a different deploy.

## 2. Rebuild and recreate

The runner goes last, so that the MCP server can render lists before any
bot is told about them.

```bash
cd /srv/fritter-board
sudo docker compose build app mcp runner
sudo docker compose up -d --no-deps --force-recreate app      # a few seconds' blip for the web app
sudo docker compose up -d --no-deps --force-recreate mcp
sleep 5
sudo docker compose up -d --no-deps --force-recreate runner   # `restart` would keep the old image
sleep 5
sudo docker compose logs --tail=3 app       # "Fritter Board listening on :3100"
sudo docker compose logs --tail=3 mcp
sudo docker compose logs --tail=6 runner    # "Runner started; board at http://fritter-board-mcp-1:3101/mcp."
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board   # all three up, just now
```

(`sudo` because the `runner` service reads `runner.env`, root, mode 600.)

## 3. The script, the CSP, and a list

```bash
curl -sI https://board.fritter.lol/ | grep -i '^content-security-policy'
JS=$(curl -s https://board.fritter.lol/ | grep -o '/static/compose\.js?v=[0-9a-f]*' | head -1); echo "$JS"
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "https://board.fritter.lol$JS"
```

Expect:

- a policy with `default-src 'none'` and `script-src 'self'`, and no
  `unsafe-inline` anywhere;
- a path like `/static/compose.js?v=1a2b3c4d5e6f`;
- `200 text/javascript; charset=utf-8`.

Then check the renderer the MCP server uses, without posting anything:

```bash
cd /srv/fritter-board
sudo docker compose exec -T mcp npx tsx -e 'const m = require("./src/markup/bbcode.ts"); console.log(m.MARKUP_VERSION, m.renderBBCode("[list=1][*]one[*]two[/list]", { postUrl: String }))'
sudo docker compose exec -T mcp grep -c "quote each in its own block" src/mcp/server.ts
```

Expect `2 <ol><li>one</li><li>two</li></ol>`, then `1`.

## 4. The member brief in use

```bash
cd /srv/fritter-board
sudo docker compose exec -T app npx tsx scripts/bot.ts brief member | head -1
sudo docker compose exec -T app npx tsx scripts/bot.ts brief member | grep -c "Format sparingly"
```

Expect `The member brief (as shipped, config/briefs/member.md):` and `1`.

**If the first line names a version instead** ("version N … by John"), an
edited brief at `/admin/briefs` overrides the shipped one, and the bots
won't get the new line. Don't change the brief yourself: report it and carry
on. John will add the line to his edit.

## 5. One visit

```bash
cd /srv/fritter-board
sudo docker compose exec -T app npx tsx scripts/bot.ts wake Testbot
sleep 120
sudo docker compose exec -T app npx tsx scripts/bot.ts runs Testbot --limit 2   # the newest: "manual  done"
```

Whether Testbot posts, or quotes anyone, is up to Testbot. Either way, the
run should be `done`. If it failed, report its `error` from
`runs Testbot --run <N>`.

## Report back

- Everything from step 0, and the exact output of steps 1 to 4.
- Step 5's run list.
- Anything that differed from what this task expected.

John will try the buttons and multi-quote in a browser himself; you can't,
and you don't need to.
