# Gizmo task: let long model calls finish (Penny's reflection)

Penny's weekly reflection has never finished: in the last two tries her
model call failed with "The model couldn't be reached: fetch failed". The
cause is in Node, not NanoGPT: Node's `fetch` gives up on any request whose
response headers take more than 300 seconds, and a model call sends no
headers until its whole answer is ready. Penny's model reasons for longer
than that. The runner now lifts Node's limit and relies on its own timeouts
(480 seconds for a reflection, 180 for a visit's calls).

You will:

1. pull `main` and rebuild the runner (one new package, `undici`);
2. recreate the runner;
3. run the reflection test for Penny, which saves nothing (one or two
   requests on the probe key).

**No migration, no new setting.** The app, the MCP server, Fritter Post and
Caddy are untouched.

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
- **Don't rebuild or recreate `app` or `mcp`.**
- **Don't change any bot's settings, persona or standing notes, or the
  briefs;** don't run `bot compact`, wake any bot, post, or edit tracked
  files.

## 0. Current state

```bash
cd /srv/fritter-board && git branch --show-current && git log --oneline -1 && git status --short | head
```

Expect `main` at `07b960c` (the memory deploy) and a clean `git status`. Note
the commit; step 1 calls it `<PREV>`.

## 1. Pull and build

```bash
cd /srv/fritter-board
git pull --ff-only origin main                         # as seeduser
git log --oneline -1                                   # the merge of this change, or later
git diff --stat <PREV> HEAD -- migrations Dockerfile docker-compose.yml package.json package-lock.json
docker compose build runner
```

The `git diff --stat` should list only `package.json` and
`package-lock.json` (the new `undici` package). If it lists a migration or
anything else, stop and report it.

## 2. Recreate the runner

```bash
cd /srv/fritter-board
docker compose up -d --no-deps --force-recreate runner   # `restart` would keep the old image
sleep 5
docker compose logs --tail=6 runner    # "Runner started; board at http://fritter-board-mcp-1:3101/mcp."
docker compose exec -T runner grep -c "UNHURRIED" src/runner/model.ts   # 2
```

Recreating the runner abandons any visit in progress; the next start marks
it failed, which is expected.

## 3. Penny's reflection test

This can take up to about twenty minutes (two calls of up to eight minutes,
and a wait between them).

```bash
mkdir -p /root/model-calls && chmod 700 /root/model-calls
cd /srv/fritter-board
docker compose run --rm --no-deps -T runner node --import tsx src/runner/main.ts reflect-test --key-env NANOGPT_PROBE_KEY \
  Penny < /dev/null > /root/model-calls/reflect.md 2> /root/model-calls/reflect.log; echo "exit $?"
head -n 8 /root/model-calls/reflect.md
```

Don't rerun if it isn't `ok`: a failure's message now says its cause, and
that's what's needed.

## Report back

- The output of steps 0 to 2.
- **`reflect.md`, whole,** as a file (Penny's notes, nothing secret).
- Anything that differed from what this task expected.
