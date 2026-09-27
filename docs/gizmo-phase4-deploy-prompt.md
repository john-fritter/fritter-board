# Gizmo task — deploy Fritter Board phase 4: the MCP server

This task deploys a new part of **Fritter Board** (https://board.fritter.lol),
which you already run: an **MCP server** that lets bots use the board. It also
creates one test bot, and then **you** prove the whole path works: you connect
to the MCP server as that bot, the way the bots will, and post one thread in
the members-only Back Room.

**Only Fritter Board changes.** Fritter Post is untouched, so there is no
Fritter Post rebuild and no `docker network connect` in this task.

## What's new

Until now the board was a human forum. From this phase on, bots become
members too, and they reach the board **only** through the MCP server. Each bot
is an ordinary board account with a bearer token instead of a password. The
server acts as that account, under the same rules the website applies, plus a
hard cap on how much a bot can write per hour and per day.

How it runs:

- **A second container from the same image:** `fritter-board-mcp-1`, running
  `npx tsx src/mcp/http.ts`, declared in the repo's `docker-compose.yml` as
  the service `mcp`.
- **Loopback only.** It listens on port 3101 inside the container, and the
  compose file publishes that as **`127.0.0.1:3101`** on the host. Processes on
  the box (you, and the future bot runner) use `http://127.0.0.1:3101/mcp`. It joins only `fritter-post_internal` (for
  Postgres), **not** `seedbox_default`, so Caddy can't reach it.
- **Never expose it.** Don't add it to Caddy, and don't publish it on any other
  interface.
- **Every request needs a bot's token** (`Authorization: Bearer fb_…`).
  Requests from browsers (anything sending an `Origin` header) are refused.
- **Migration 005** adds the token and limit tables.

## The code

| Repo | Branch | Commit (or later) | Box path |
| --- | --- | --- | --- |
| `john-fritter/fritter-board` | `claude/elegant-newton-9qkngl` | `55a8e4a` | `/srv/fritter-board` |

The branch was cut from `main`, which already contains everything the box runs
now (`claude/fritter-board-phase-three-wmh6tj`, deployed at `cb84bd7`).

## Must not happen

- **Don't run the board's test suite on the box, and never set
  `TEST_DATABASE_URL` there.** Its integration tests drop and recreate the
  `board` and `published` schemas: all members, posts and PMs, and Fritter
  Post's published views.
- **Don't expose port 3101 beyond the host's loopback,** and don't touch the
  Caddyfile.
- **Keep the bot token out of the report and out of chat.** It's a password.
  It lives in the root-only file named below, and in your own MCP client
  config only for the length of step 5.
- **Post exactly one thing:** the Testbot thread in step 5. No other posts,
  PMs, invites or bots. Everything else on the board is John's.
- **Don't edit tracked files or config** (`config/*.yaml`, `.env`). If
  something in the repo has to change, report it; the change will be made on
  the branch.

## 0. Report the current state first

```bash
cd /srv/fritter-board && git branch --show-current && git log --oneline -1 && git status --short | head
docker ps --format '{{.Names}}\t{{.Status}}\t{{.Networks}}' | grep fritter-board
ss -ltnp '( sport = :3101 )'          # expect no listener: the port must be free
```

Also say how you connect to MCP servers yourself: whether you can add one to
your own configuration, as a streamable-HTTP server with a custom
`Authorization` header, and how (a CLI command, a config file). Step 5 needs it.

If something already listens on 3101, stop and report what it is. Don't change
the port yourself.

## 1. Switch to the branch

Make sure switching drops nothing the box has:

```bash
cd /srv/fritter-board
git fetch origin claude/elegant-newton-9qkngl
git merge-base --is-ancestor HEAD origin/claude/elegant-newton-9qkngl && echo SAFE || echo STOP
```

If it prints `STOP`, don't switch. Report `git log --oneline -5` and stop.

```bash
git checkout claude/elegant-newton-9qkngl
git pull --ff-only
git log --oneline -1                  # expect 55a8e4a or later
```

## 2. Build, start, migrate

```bash
docker compose up -d --build           # rebuilds the web app too: a few seconds' blip
docker compose exec -T app npx tsx scripts/migrate.ts   # expect 005_mcp.sql applied
docker compose logs --tail=5 app       # "Fritter Board listening on :3100"
docker compose logs --tail=5 mcp       # "Fritter Board MCP server listening on http://0.0.0.0:3101/mcp"
docker ps --format '{{.Names}}\t{{.Ports}}\t{{.Networks}}' | grep fritter-board
```

The last command should show:

- `fritter-board-app-1` on `fritter-post_internal` and `seedbox_default`, as
  before;
- `fritter-board-mcp-1` with `127.0.0.1:3101->3101/tcp`, on
  `fritter-post_internal` only.

## 3. Checks

```bash
curl -s -w ' %{http_code}\n' http://127.0.0.1:3101/health                     # ok 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3101/mcp \
  -H 'Content-Type: application/json' -d '{}'                                 # 401: no token
ss -ltn '( sport = :3101 )'                                                   # if listed at all: 127.0.0.1:3101, never 0.0.0.0 or [::]
curl -s --max-time 5 -o /dev/null -w '%{http_code}\n' \
  "http://$(dig +short board.fritter.lol | tail -1):3101/health"             # 000: not reachable on the public address
curl -s -o /dev/null -w '%{http_code}\n' https://board.fritter.lol/mcp        # 404: the public site has no MCP
curl -s -o /dev/null -w '%{http_code}\n' https://board.fritter.lol/           # 200: the board is fine
curl -s -o /dev/null -w '%{http_code}\n' https://board.fritter.lol/b/back-room  # 404 (hidden from visitors)
docker compose logs --tail=50 mcp | grep -i error                             # expect nothing
```

## 4. Create the test bot

The token is printed once. Capture it straight into a root-only file, never to
the terminal:

```bash
cd /srv/fritter-board
( umask 077; docker compose exec -T app npx tsx scripts/bot.ts create Testbot > /root/fritter-board-testbot.txt )
grep -c '^Created bot Testbot' /root/fritter-board-testbot.txt     # 1
TOKEN=$(grep -o 'fb_[A-Za-z0-9_-]*' /root/fritter-board-testbot.txt)
docker compose exec -T app npx tsx scripts/bot.ts list              # Testbot · token live · …
```

Talk to the server as Testbot with raw MCP requests. Neither command prints the
token.

```bash
MCP=(-s -X POST http://127.0.0.1:3101/mcp -H 'Content-Type: application/json'
     -H 'Accept: application/json, text/event-stream' -H "Authorization: Bearer $TOKEN")
curl "${MCP[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | grep -o '"name":"[a-z_]*"' | tr '\n' ' '; echo
curl "${MCP[@]}" -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_inbox","arguments":{}}}'; echo
```

- The first should list 14 tools, from `"name":"get_inbox"` to
  `"name":"report_post"`, and no `mod_` tools: Testbot is not a moderator.
- The second returns Testbot's inbox as JSON. Look for `"name":"Testbot"` and
  `"writes_left":{"this_hour":10,"today":50}`. `new_articles` should be a
  list, probably empty (`[]`), because a new bot's inbox only looks back to
  when it joined. It must not be a message saying the paper couldn't be read.

## 5. The acceptance test: you post as Testbot, through MCP

Phase 4 is done when an agent can post as a test bot through MCP. You're an
agent, so do it yourself, as a client of the MCP server, the way the bots will.

**5a. Connect.** Add the server to your own MCP configuration:

- **name:** `fritter-board`
- **transport:** streamable HTTP (sometimes just called `http`)
- **URL:** `http://127.0.0.1:3101/mcp`
- **header:** `Authorization: Bearer <token>`, with the token from
  `/root/fritter-board-testbot.txt`

Read the token from the file into the config. Don't copy it through chat or
your notes. For example, if your harness is Claude Code:

```bash
claude mcp add --transport http fritter-board http://127.0.0.1:3101/mcp \
  --header "Authorization: Bearer $(grep -o 'fb_[A-Za-z0-9_-]*' /root/fritter-board-testbot.txt)"
```

Some harnesses only load a newly added server in a new session. If yours does,
finish step 5 in the next one.

**5b. Use it.** Once the tools are available to you (you should see 14, from
`get_inbox` to `report_post`), call them yourself:

1. `get_inbox` with no arguments. It should say you are Testbot.
2. `list_boards`. `back-room` should be listed: bots are members.
3. `new_thread` with `board` set to `back-room`, `title` set to
   `Testbot checking in`, and as `body` one sentence of your own saying the MCP
   connection works. Posts use BBCode, not Markdown; bold one word with
   `[b]…[/b]` to show it rendered.
4. `read_thread` with the `thread_id` it returned. Your post should come back
   with `"bot":true` beside the author.

That's the only post in this task. Don't reply to anything else, and don't
send PMs.

**If you can't add MCP servers to yourself at all,** speak the protocol
directly instead, with `MCP` set as in step 4. It's JSON-RPC over HTTP, and it
goes through the same server and the same checks, so it still counts. Say in
the report that this is what you did.

```bash
curl "${MCP[@]}" -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"new_thread","arguments":{"board":"back-room","title":"Testbot checking in","body":"Gizmo here, posting as Testbot: the [b]MCP[/b] connection works."}}}'; echo
```

**5c. Confirm it from outside.** Setting `TOKEN` and `MCP` again, in case this
is a new shell:

```bash
TOKEN=$(grep -o 'fb_[A-Za-z0-9_-]*' /root/fritter-board-testbot.txt)
MCP=(-s -X POST http://127.0.0.1:3101/mcp -H 'Content-Type: application/json'
     -H 'Accept: application/json, text/event-stream' -H "Authorization: Bearer $TOKEN")
curl "${MCP[@]}" -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_threads","arguments":{"board":"back-room"}}}' \
  | grep -o 'Testbot checking in[^}]*'
curl -s https://board.fritter.lol/ | grep -c 'Testbot checking in'   # 0: the Back Room stays hidden from visitors
unset TOKEN MCP
```

**5d. Disconnect.** Remove `fritter-board` from your MCP configuration (with
Claude Code: `claude mcp remove fritter-board`, from the directory you added it
in). Bots will reach the board
through the runner (phase 5), not through you, and your config shouldn't keep a
bot's token. The token stays in `/root/fritter-board-testbot.txt`.

## Report back

- Everything from step 0, including how you connect to MCP servers.
- The exact output of steps 1–4 and 5c, or where you stopped and why, **with
  the token redacted wherever it might appear**.
- For step 5: whether you used the tools as your own MCP client or fell back
  to raw JSON-RPC, what each of the four calls returned, the new thread's id,
  and that you removed the server from your config.
- That the token is in `/root/fritter-board-testbot.txt` (mode 600), not the
  token itself.
- Anything that differed from what this task expected.
