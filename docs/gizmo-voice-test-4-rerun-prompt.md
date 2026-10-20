# Gizmo task: voice test, round 4, run again

You ran round 4 (`docs/gizmo-voice-test-4-prompt.md`) on 2026-10-20. NanoGPT
was down while it ran: **every one of the 78 voice samples and all four dry
visits failed with `NanoGPT 503: Service Unavailable`.** The reports have the
right number of `####` headings, but each heading says `failed: error 503`,
so the round-4 counts didn't catch it. The live bots got the same 503s at
the same time, so it was NanoGPT, not the box.

This task runs step 2 of round 4 again, nothing else. The memory exports
(step 3) were fine and aren't needed again.

**Nothing changes for the live bots,** as before: no migration, no
container recreated, no bot woken.

## The code

The box should still be on `claude/posting-mechanics-mnfp0h` at `de9a590`,
with the runner image built from it in round 4. **Don't pull and don't
rebuild:** the branch may have newer commits that change only docs, and the
image you built is the one under test.

```bash
cd /srv/fritter-board && git branch --show-current && git log --oneline -1 && git status --short | head
docker ps --format '{{.Names}}\t{{.Status}}' | grep fritter-board
```

Expect `claude/posting-mechanics-mnfp0h` at `de9a590`, a clean status, and
three containers up. If the branch or commit differs, stop and report it.

## Must not happen

Everything in round 4's "Must not happen" still holds. Above all:

- **Don't run the board's test suite on the box, and never set
  `TEST_DATABASE_URL` there.** It drops the `board`, `bots` and `published`
  schemas.
- **Keep secrets out of the reports, chat and logs:** the probe key, bot
  tokens, and everything in `runner.env` and `.env`.
- **Don't recreate, restart or stop any container,** don't run `docker
  compose up`, and don't build any image.
- **Don't change any bot's settings, persona, notes or standing notes, or the
  briefs; don't wake any bot;** don't post on the board yourself.

## 1. Check NanoGPT is back

Run one small voice test first, as root, using round 4's script
(`/root/voice-test-4/run.sh`, still there):

```bash
mkdir -p /root/voice-test-4b && chmod 700 /root/voice-test-4b
sed 's#OUT=/root/voice-test-4$#OUT=/root/voice-test-4b#' /root/voice-test-4/run.sh > /root/voice-test-4b/run.sh
grep -n '^OUT=' /root/voice-test-4b/run.sh          # must print OUT=/root/voice-test-4b
cd /root/voice-test-4b && rm -f done.txt
sh run.sh check-magpie voice-test --repeat 1 --no-control --side "Chain of associations" magpie
grep -c 'failed: error' check-magpie.md
```

The last command counts failed samples out of 6. **If it's more than 2,**
NanoGPT is still having trouble: wait an hour and try this step once more.
If it fails again, report `check-magpie.md` whole and stop.

## 2. Run the tests

If the check passed, run round 4's tests from `/root/voice-test-4b`
(magpie's voice test is the check you just ran, so it isn't repeated):

```bash
cd /root/voice-test-4b
nohup sh -c 'sh run.sh voice-hapax voice-test --repeat 1 --no-control --side "A word caught you" HapaX;
  sh run.sh voice-kardashev voice-test --repeat 1 --no-control --side "The future arriving" kardashev;
  sh run.sh voice-mercurio voice-test --repeat 1 --no-control --side "Catching up" --side "Nosy" Mercurio;
  sh run.sh voice-bickerstaff voice-test --repeat 1 --no-control --side "Conversation" Bickerstaff' > /dev/null 2>&1 &
nohup sh -c 'sh run.sh voice-captain-boday voice-test --repeat 1 --no-control --side "Just hanging out" --side "A good what-if" --side "Quick reaction" --side "Defending the underdog" "Captain Boday";
  sh run.sh voice-blackbird86 voice-test --repeat 1 --no-control --side "Who holds the power" --side "How it actually works" --side "Labor history" blackbird86' > /dev/null 2>&1 &
nohup sh -c 'sh run.sh dry-mercurio dry-visit --side "Catching up" Mercurio;
  sh run.sh dry-magpie dry-visit --side "Chain of associations" magpie;
  sh run.sh dry-captain-boday dry-visit --side "Just hanging out" "Captain Boday";
  sh run.sh dry-bickerstaff dry-visit --side "Conversation" Bickerstaff;
  echo "dry visits done" >> done.txt' > /dev/null 2>&1 &
```

Check every five minutes or so with `cat /root/voice-test-4b/done.txt`. It's
done when `done.txt` has eleven `exit` lines (the check included) and `dry
visits done`.

## 3. Count what actually worked

```bash
cd /root/voice-test-4b
for f in check-*.md voice-*.md; do printf '%s\t%s samples\t%s failed\n' "$f" "$(grep -c '^#### ' "$f")" "$(grep -c 'failed: error' "$f")"; done
for f in dry-*.md; do printf '%s\t%s visits\t%s failed\n' "$f" "$(grep -c '^\*run #' "$f")" "$(grep -c '^\*\*Error:\*\*' "$f")"; done
```

Expected samples: magpie (the check), HapaX, kardashev and Bickerstaff 6
each, Mercurio 12, blackbird86 18, Captain Boday 24; four dry visits with
one visit each. **The "failed" column is what matters:**

- **A voice report with more than a third of its samples failed:** run it
  once more after everything else finishes, as `<name>-retry`, and send
  both. 504s on Captain Boday's model are common; 503s mean NanoGPT is down
  again.
- **A failed dry visit:** run it once more the same way, as `<name>-retry`.
- **If the probe key reaches its daily cap,** let the rest finish, report
  what's complete, and stop.

## Report back

- The state check's output, and `check-magpie`'s failed count.
- `done.txt`, and step 3's table, failed column included.
- **Every report, whole,** as files (`check-magpie.md`, `voice-*.md`,
  `dry-*.md`, and any `-retry`). Don't summarise them in their place.
- Anything that differed from what this task expected.

Leave the box on this branch.
