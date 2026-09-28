import { config } from "../config.js";
import { callJson, type InboxJson } from "./board.js";
import { compactionDue, runCompaction } from "./compaction.js";
import { firstWake, isAwake, nextWake } from "./schedule.js";
import {
  activeBots,
  earlyWakesLastDay,
  failAbandonedRuns,
  pruneTranscripts,
  updateState,
  type Bot,
  type Trigger,
} from "./store.js";
import { earlyWakeReason, runWake, type WakeDeps } from "./wake.js";

/**
 * The runner's clock. Each tick it looks for bots that are due and wakes them
 * one at a time; every few minutes it also peeks at each bot's inbox for a PM
 * or an @mention from John (runner.early_wake_for), which brings that bot's
 * next wake forward to within a few minutes. After the wakes, bots that are
 * asleep and due one get a compaction of their notes.
 */

export interface RunnerDeps extends WakeDeps {
  log(line: string): void;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export class Runner {
  private lastEarlyPoll = 0;
  private lastPrune = 0;

  constructor(private readonly deps: RunnerDeps) {}

  /** Once, before the first tick: runs a stopped runner left open are failed. */
  async start(): Promise<void> {
    const n = await failAbandonedRuns(this.deps.db);
    if (n > 0) this.deps.log(`Marked ${n} interrupted run(s) as failed.`);
  }

  async tick(): Promise<void> {
    const { deps } = this;
    let now = deps.now();
    if (now.getTime() - this.lastPrune >= HOUR) {
      this.lastPrune = now.getTime();
      await pruneTranscripts(deps.db);
    }
    if (now.getTime() - this.lastEarlyPoll >= config.runner.early_wake_poll_minutes * MINUTE) {
      this.lastEarlyPoll = now.getTime();
      await this.pollEarlyWakes(now);
    }

    for (const bot of await activeBots(deps.db)) {
      now = deps.now();
      if (bot.pausedUntil && bot.pausedUntil > now) continue;
      if (bot.nextWakeAt === null) {
        // New, or resumed: first wake somewhere in its first interval.
        await updateState(deps.db, bot.userId, { nextWakeAt: firstWake(now, bot.schedule, deps.random) });
        continue;
      }
      const trigger = this.dueTrigger(bot, now);
      if (trigger) await this.wake(bot, trigger);
    }

    for (const bot of await activeBots(deps.db)) {
      now = deps.now();
      if (bot.pausedUntil && bot.pausedUntil > now) continue;
      const trigger = await compactionDue(deps, bot, now);
      if (trigger) await this.compact(bot, trigger);
    }
  }

  private async compact(bot: Bot, trigger: Trigger): Promise<void> {
    const { deps } = this;
    deps.log(`Compacting ${bot.username}'s notes (${trigger}).`);
    let res;
    try {
      res = await runCompaction(deps, bot, trigger);
    } catch (err) {
      deps.log(`Compaction of ${bot.username} failed: ${err instanceof Error ? err.message : String(err)}`);
      res = null;
    }
    // Tried, either way: a failure waits compaction_retry_hours, not the next tick.
    await updateState(deps.db, bot.userId, {
      compactRequestedAt: null,
      ...(res?.pausedUntil ? { pausedUntil: res.pausedUntil } : {}),
    });
    if (res) deps.log(`${bot.username}: compaction ${res.outcome} (run ${res.runId}).`);
  }

  private dueTrigger(bot: Bot, now: Date): Trigger | null {
    if (bot.earlyWakeAt && bot.earlyWakeAt <= now) return bot.earlyWakeTrigger ?? "early";
    if (bot.nextWakeAt && bot.nextWakeAt <= now) return "schedule";
    return null;
  }

  private async wake(bot: Bot, trigger: Trigger): Promise<void> {
    const { deps } = this;
    const now = deps.now();
    if (trigger === "schedule" && !isAwake(now, bot.schedule)) {
      // Missed while the runner was down, and now it's outside the window.
      await updateState(deps.db, bot.userId, { nextWakeAt: nextWake(now, { ...bot.schedule, intervalMin: 0, intervalMax: 0 }, deps.random) });
      return;
    }
    deps.log(`Waking ${bot.username} (${trigger}).`);
    let res;
    try {
      res = await runWake(deps, bot, trigger);
    } catch (err) {
      // runWake records its own failures; this is the database itself failing.
      deps.log(`Wake of ${bot.username} failed: ${err instanceof Error ? err.message : String(err)}`);
      res = null;
    }
    const after = deps.now();
    await updateState(deps.db, bot.userId, {
      nextWakeAt: nextWake(after, bot.schedule, deps.random),
      earlyWakeAt: null,
      earlyWakeTrigger: null,
      ...(res?.cursor ? { inboxCursor: res.cursor } : {}),
      ...(res?.pausedUntil ? { pausedUntil: res.pausedUntil } : {}),
    });
    if (res) deps.log(`${bot.username}: ${res.outcome} (run ${res.runId}).`);
  }

  /** Peeks at each awake bot's inbox for a PM or @mention from John. No model is involved. */
  async pollEarlyWakes(now: Date): Promise<void> {
    const { deps } = this;
    if (config.runner.early_wake_for.length === 0) return;
    for (const bot of await activeBots(deps.db)) {
      if (bot.earlyWakeAt || (bot.pausedUntil && bot.pausedUntil > now)) continue;
      if (!isAwake(now, bot.schedule)) continue;
      if ((await earlyWakesLastDay(deps.db, bot.userId)) >= config.runner.early_wakes_per_day) continue;
      const token = deps.secret(bot.boardTokenRef);
      if (!token) continue;
      try {
        const board = await deps.connectBoard(token);
        try {
          const inbox = await callJson<InboxJson>(board, "get_inbox", {
            ...(bot.inboxCursor ? { since: bot.inboxCursor.toISOString() } : {}),
            peek: true,
          });
          const reason = earlyWakeReason(inbox, bot.inboxCursor);
          if (reason) {
            const { early_wake_delay_min_minutes: lo, early_wake_delay_max_minutes: hi } = config.runner;
            const at = new Date(now.getTime() + (lo + deps.random() * Math.max(0, hi - lo)) * MINUTE);
            await updateState(deps.db, bot.userId, { earlyWakeAt: at, earlyWakeTrigger: "early" });
            deps.log(`${bot.username} will wake early at ${at.toISOString()}: ${reason}.`);
          }
        } finally {
          await board.close().catch(() => {});
        }
      } catch (err) {
        deps.log(`Early-wake check for ${bot.username} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
