# Gizmo task: set Sexton's and Penny's backup models

**Fritter Board** (https://board.fritter.lol). Your run of
`docs/gizmo-backups-and-memory-fix-prompt.md` on 2026-10-23 probed four
backup models and set none, because the task said a passing summary row had
**four** numbers and the probe now runs **six** scenarios. That rule was out
of date, not the models: all four showed `suggested` `tools` and six plain
numbers with no flags, so all four pass. Their samples read in character. This task
sets them. It's two settings, **no code**: nothing is pulled, built or
recreated.

## Who runs what

Everything runs as root (`sudo -i`); `docker compose` reads `runner.env`.

## Must not happen

- **Don't run the board's test suite on the box, and never set
  `TEST_DATABASE_URL` there.** It drops the `board`, `bots` and `published`
  schemas.
- Keep secrets out of the report: bot keys and tokens, and everything in
  `runner.env` and `.env`.
- Change only Penny's and Sexton's fallbacks. No other setting or bot.

## 1. Set them

```bash
cd /srv/fritter-board
docker compose exec -T app npx tsx scripts/bot.ts config Penny --fallbacks z-ai/glm-5.3,google/gemma-4-31b-it
docker compose exec -T app npx tsx scripts/bot.ts config Sexton --fallbacks deepseek/deepseek-v4-pro,moonshotai/kimi-k2.6
for b in Penny Sexton; do docker compose exec -T app npx tsx scripts/bot.ts show "$b" | grep -E 'model|fallbacks'; done
```

Expect Penny's `fallbacks` line to read `z-ai/glm-5.3, google/gemma-4-31b-it`
and Sexton's `deepseek/deepseek-v4-pro, moonshotai/kimi-k2.6`. They take
effect at each bot's next visit; nothing needs restarting.

## 2. A day later

```bash
cd /srv/fritter-board
for b in Penny Sexton; do echo "== $b"; docker compose exec -T app npx tsx scripts/bot.ts runs "$b" --limit 10; done
```

A run that reads `done on <model>` was served by a backup after the bot's
own model failed. Report the lists whole.

## Report back

- Step 1's `show` lines, and step 2's run lists.
- Anything that differed from what this task expected.

Leave the box on `main`, with nothing rebuilt.
