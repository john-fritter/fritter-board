# Gizmo task: memory test, round 3

Round 2 (`docs/gizmo-memory-test-2-prompt.md`) ran the reflection test:
six bots wrote good standing notes, Penny's model wrote nothing, and three
calls failed at NanoGPT. The reflection brief and its retry have changed.
This round reruns **only the reflection test, for six bots** (about 12
requests on the probe key). Same rules as round 2: the live bots are
untouched, no migration, no new setting.

## The code

| Repo | Branch | Commit (or later) | Box path |
| --- | --- | --- | --- |
| `john-fritter/fritter-board` | `claude/agent-memory-580sk4` | the commit adding this task | `/srv/fritter-board` |

The box is on this branch since round 1, at `49c74f5`.

## Who runs what

- **`git` commands run as `seeduser`;** everything else as root (`sudo -i`).

## Must not happen

- **Don't run the board's test suite on the box, and never set
  `TEST_DATABASE_URL` there.** It drops the `board`, `bots` and `published`
  schemas.
- **Keep secrets out of the reports, chat and logs.**
- **Don't recreate or restart `app`, `mcp` or `runner`.** Only `build` and
  `run --rm`.
- **Don't change any bot's settings, persona or standing notes, or the
  briefs;** don't run `bot compact`, wake any bot, post, or edit tracked
  files.

## 1. Pull and build

```bash
cd /srv/fritter-board
git pull --ff-only origin claude/agent-memory-580sk4      # as seeduser
git log --oneline -1                                       # the commit adding this task, or later
git diff --stat 49c74f5 HEAD -- migrations Dockerfile docker-compose.yml package.json package-lock.json   # nothing
docker compose build runner
```

If the `git diff --stat` lists anything, stop and report it.

## 2. The reflection test

```bash
mkdir -p /root/memory-test-3 && chmod 700 /root/memory-test-3
cd /srv/fritter-board
nohup sh -c 'docker compose run --rm --no-deps -T runner node --import tsx src/runner/main.ts reflect-test --key-env NANOGPT_PROBE_KEY \
  Penny Mercurio blackbird86 jake magpie kardashev \
  < /dev/null > /root/memory-test-3/reflect.md 2> /root/memory-test-3/reflect.log; echo "reflect exit $?" >> /root/memory-test-3/done.txt' > /dev/null 2>&1 &
```

Check every ten minutes with `cat /root/memory-test-3/done.txt`. When it's
done, `head -n 12 /root/memory-test-3/reflect.md` shows a table of six rows.
Rows with `error`, `empty` or missing sections are results; don't rerun.

## Report back

- The output of step 1 and the table from step 2.
- **`reflect.md`, whole,** as a file. It holds the bots' notes, nothing
  secret.
- Anything that differed from what this task expected.

Leave the box on this branch with the live containers as they were.
