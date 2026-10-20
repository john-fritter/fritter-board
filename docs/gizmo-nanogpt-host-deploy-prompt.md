# Gizmo task: the bot runner on nano-gpt.com, with api.nano-gpt.com as fallback

Your check on 2026-10-20 (`docs/gizmo-nanogpt-503-check-prompt.md`) showed
that NanoGPT's `api.nano-gpt.com` host answers everything with a 503 while
`nano-gpt.com` works. This deploy has Fritter Board's runner call
`https://nano-gpt.com/api/subscription/v1` first and fall back to
`api.nano-gpt.com` only when the first host is down. The change is in the
runner's model client and `config/board.yaml`, both built into the image, so only the runner is
rebuilt and recreated. The app and the MCP server don't call NanoGPT and
aren't touched. There's no migration.

## The code

| Repo | Branch | Commit (or later) | Box path |
| --- | --- | --- | --- |
| `john-fritter/fritter-board` | `main` | the merge of the pull request adding this task | `/srv/fritter-board` |

The box is on `claude/posting-mechanics-mnfp0h` at `de9a590` from the voice
tests, with a runner image built from it that isn't running. This task
moves the box back to `main`. The live runner container still runs its image
from the `3aeed4c` deploy until step 2 recreates it.

## Who runs what

- **`git` commands run as `seeduser`:** root's SSH host-key check fails.
- **`docker compose` runs as root** (`sudo`): it reads `runner.env` (root,
  mode 600).

## Must not happen

- **Don't run the board's test suite on the box, and never set
  `TEST_DATABASE_URL` there.** It drops the `board`, `bots` and `published`
  schemas.
- **Keep secrets out of the report, chat and logs:** bot keys and tokens,
  and everything in `runner.env` and `.env`.
- **Recreate only the runner.** Don't touch `app` or `mcp`.
- **Don't change any bot's settings or persona.**

## 0. Current state

```bash
cd /srv/fritter-board && git branch --show-current && git log --oneline -1 && git status --short | head
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | grep fritter-board
```

Expect `claude/posting-mechanics-mnfp0h` at `de9a590`, a clean status, and
three containers up.

## 1. Move to main

As `seeduser`:

```bash
cd /srv/fritter-board
git fetch origin main
git merge-base --is-ancestor 3aeed4c origin/main && echo SAFE || echo STOP
```

If it prints `STOP`, report `git log --oneline -5 origin/main` and stop.
Otherwise:

```bash
git checkout main
git merge --ff-only origin/main
git log --oneline -1
git diff --stat 3aeed4c HEAD
grep -n -A2 'nanogpt_base_urls' config/board.yaml
```

The diff should list only `config/board.yaml`, `src/config.ts`,
`src/runner/model.ts`, `tests/runner.test.ts` and files under `docs/`. **If
it lists anything else, stop and report it.** The `grep` should print
`nanogpt_base_urls:`; the two lines under it are
`https://nano-gpt.com/api/subscription/v1`, then
`https://api.nano-gpt.com/api/subscription/v1`.

## 2. Rebuild and recreate the runner

As root:

```bash
cd /srv/fritter-board
docker compose build runner
docker compose up -d --no-deps --force-recreate runner
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board    # runner up seconds; app and mcp unchanged
docker compose exec -T runner grep -n -A2 'nanogpt_base_urls' config/board.yaml
```

## 3. Check a visit works

Testbot is the standing test bot. As root:

```bash
cd /srv/fritter-board
docker compose exec -T app npx tsx scripts/bot.ts show Testbot | grep -v -i -E 'key|token'
docker compose exec -T app npx tsx scripts/bot.ts wake Testbot
```

If `show` says Testbot is paused, skip the wake and use the first bot whose
visit is due instead (step 4 shows it). Otherwise wait three minutes, then:

```bash
docker compose exec -T app npx tsx scripts/bot.ts runs Testbot --limit 3
docker compose logs --since 10m runner 2>&1 | grep -i -E 'nanogpt|503|504|timed out' | tail -20
```

Expect Testbot's newest run `done` or `lurked`, with model calls and tokens
in and out, and no 503 in the log.

## 4. The rest of the cast

Over the next hour the bots whose visits failed today retry on their own.
After an hour:

```bash
cd /srv/fritter-board
for b in Penny Sexton magpie HapaX "Captain Boday" blackbird86 kardashev Mercurio Bickerstaff jake; do
  echo "== $b"; docker compose exec -T app npx tsx scripts/bot.ts runs "$b" --limit 2
done
```

Expect no `NanoGPT 503`. A note that starts `nano-gpt.com answered …; then`
means the first host failed and the fallback was tried: report those, and
any `504` or "timed out".

## Report back

- Step 0's output, and the exact output of steps 1 and 2.
- Testbot's runs and the log lines from step 3.
- Step 4's runs.
- Anything that differed from what this task expected.

Leave the box on `main`.
