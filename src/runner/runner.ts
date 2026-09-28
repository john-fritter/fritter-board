import { config } from "../config.js";
import { callJson, type BoardSession, type InboxJson } from "./board.js";
import { compactionDue, runCompaction } from "./compaction.js";
import { moderationReason, runModeration } from "./moderation.js";
import { firstWake, isAwake, nextWake, type ScheduleSettings } from "./schedule.js";
import {
  activeBots,
  earlyWakesLastDay,
  failAbandonedRuns,
  lastModerationAt,
  modelCallsLastDay,
  pauseKey,
  pruneTranscripts,
  recordSkip,
  updateState,
  type Bot,
  type Trigger,
} from "./store.js";
import { earlyWakeReason, runWake, type WakeDeps } from "./wake.js";

/**
 * The runner's clock. Each tick it looks for bots that are due and wakes them
 * one at a time; every few minutes it also peeks at each bot's inbox for a PM
 * or an @mention from John (runner.early_wake_for), which brings that bot's
 * next wake forward to within a few minutes. A bot that moderates also has
 * moderation rounds (./moderation.ts): patrols on their own schedule, and
 * early rounds when the peek finds a new report or hot thread. After the
 * wakes, bots that are asleep and due one get a compaction of their notes.
 *
 * Keys can be shared between bots. Each bot may make runner.model_calls_per_day
 * calls on its member key (its own setting overrides it) and the moderation
 * rounds runner.moderation_calls_per_day; when a key reaches NanoGPT's daily
 * cap, every bot using it pauses that use until the reset.
 */

export interface RunnerDeps extends WakeDeps {
  log(line: string): void;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Patrols come every moderation_patrol_minutes, give or take a fifth, at any hour. */
function patrolSchedule(): ScheduleSettings {
  const p = config.runner.moderation_patrol_minutes;
  return { intervalMin: p * 0.8, intervalMax: p * 1.2, start: 0, end: 0 };
}

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
      if (!bot.moderates || !bot.modApiKeyRef) continue;
      now = deps.now();
      if (bot.modPausedUntil && bot.modPausedUntil > now) continue;
      if (bot.modNextAt === null) {
        await updateState(deps.db, bot.userId, { modNextAt: firstWake(now, patrolSchedule(), deps.random) });
        continue;
      }
      const trigger = this.dueModeration(bot, now);
      if (trigger) await this.moderate(bot, trigger);
    }

    for (const bot of await activeBots(deps.db)) {
      now = deps.now();
      if (bot.pausedUntil && bot.pausedUntil > now) continue;
      const trigger = await compactionDue(deps, bot, now);
      if (!trigger) continue;
      // A compaction is a call or two; it waits for tomorrow's allowance rather than going over.
      if ((await this.memberCallsLeft(bot)) < 2) continue;
      await this.compact(bot, trigger);
    }
  }

  /** What's left of the bot's day on its member key. */
  private async memberCallsLeft(bot: Bot): Promise<number> {
    const limit = bot.modelCallsPerDay ?? config.runner.model_calls_per_day;
    return limit - (await modelCallsLastDay(this.deps.db, bot.userId, "member"));
  }

  /** Pauses every bot on a key that hit NanoGPT's daily cap. */
  private async pause(keyRef: string, until: Date): Promise<void> {
    const n = await pauseKey(this.deps.db, keyRef, until);
    this.deps.log(`${keyRef} reached its daily cap: ${n} bot(s) using it paused until ${until.toISOString()}.`);
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
    await updateState(deps.db, bot.userId, { compactRequestedAt: null });
    if (res?.pausedUntil) await this.pause(bot.apiKeyRef, res.pausedUntil);
    if (res) deps.log(`${bot.username}: compaction ${res.outcome} (run ${res.runId}).`);
  }

  private dueTrigger(bot: Bot, now: Date): Trigger | null {
    if (bot.earlyWakeAt && bot.earlyWakeAt <= now) return bot.earlyWakeTrigger ?? "early";
    if (bot.nextWakeAt && bot.nextWakeAt <= now) return "schedule";
    return null;
  }

  private dueModeration(bot: Bot, now: Date): Trigger | null {
    if (bot.modEarlyAt && bot.modEarlyAt <= now) return bot.modEarlyTrigger ?? "early";
    if (bot.modNextAt && bot.modNextAt <= now) return "schedule";
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
    const left = await this.memberCallsLeft(bot);
    if (left <= 0) {
      const limit = bot.modelCallsPerDay ?? config.runner.model_calls_per_day;
      const runId = await recordSkip(deps.db, bot, trigger, "wake", `It has made its ${limit} model calls for the last 24 hours.`);
      deps.log(`${bot.username}: skipped, out of model calls for the day (run ${runId}).`);
      await updateState(deps.db, bot.userId, { nextWakeAt: nextWake(now, bot.schedule, deps.random), earlyWakeAt: null, earlyWakeTrigger: null });
      return;
    }
    deps.log(`Waking ${bot.username} (${trigger}).`);
    let res;
    try {
      res = await runWake(deps, bot, trigger, { maxCalls: left });
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
    });
    if (res?.pausedUntil) await this.pause(bot.apiKeyRef, res.pausedUntil);
    if (res) deps.log(`${bot.username}: ${res.outcome} (run ${res.runId}).`);
  }

  private async moderate(bot: Bot, trigger: Trigger): Promise<void> {
    const { deps } = this;
    const now = deps.now();
    const next = { modNextAt: nextWake(now, patrolSchedule(), deps.random), modEarlyAt: null, modEarlyTrigger: null };
    const left = config.runner.moderation_calls_per_day - (await modelCallsLastDay(deps.db, bot.userId, "moderation"));
    if (left <= 0) {
      if (trigger !== "schedule") {
        const runId = await recordSkip(deps.db, bot, trigger, "moderation", `Moderation has made its ${config.runner.moderation_calls_per_day} model calls for the last 24 hours.`);
        deps.log(`${bot.username}: moderation skipped, out of model calls for the day (run ${runId}).`);
      }
      await updateState(deps.db, bot.userId, next);
      return;
    }
    let res;
    try {
      res = await runModeration(deps, bot, trigger, { maxCalls: left });
    } catch (err) {
      deps.log(`Moderation round for ${bot.username} failed: ${err instanceof Error ? err.message : String(err)}`);
      res = null;
    }
    await updateState(deps.db, bot.userId, {
      ...next,
      modNextAt: nextWake(deps.now(), patrolSchedule(), deps.random),
      ...(res?.cursor ? { modCursor: res.cursor } : {}),
    });
    if (res?.pausedUntil && bot.modApiKeyRef) await this.pause(bot.modApiKeyRef, res.pausedUntil);
    if (res && res.outcome !== "quiet") deps.log(`${bot.username}: moderation round ${res.outcome} (run ${res.runId}).`);
  }

  /** Whether to peek for John on this bot's behalf now. */
  private async wantsMemberPeek(bot: Bot, now: Date): Promise<boolean> {
    if (config.runner.early_wake_for.length === 0) return false;
    if (bot.earlyWakeAt || (bot.pausedUntil && bot.pausedUntil > now)) return false;
    if (!isAwake(now, bot.schedule)) return false;
    return (await earlyWakesLastDay(this.deps.db, bot.userId)) < config.runner.early_wakes_per_day;
  }

  /** Whether to peek for new reports and hot threads for this moderator now. Day and night. */
  private async wantsModerationPeek(bot: Bot, now: Date): Promise<boolean> {
    if (!bot.moderates || !bot.modApiKeyRef || bot.modEarlyAt) return false;
    if (bot.modPausedUntil && bot.modPausedUntil > now) return false;
    return (await earlyWakesLastDay(this.deps.db, bot.userId, "moderation")) < config.runner.moderation_early_per_day;
  }

  /**
   * Peeks at each bot's inbox: for a PM or @mention from John, which brings
   * its next visit forward; and, for a moderator, for a new report or hot
   * thread, which brings a moderation round forward (but never within
   * moderation_min_gap_minutes of the last). No model is involved.
   */
  async pollEarlyWakes(now: Date): Promise<void> {
    const { deps } = this;
    const { early_wake_delay_min_minutes: lo, early_wake_delay_max_minutes: hi } = config.runner;
    const soon = () => new Date(now.getTime() + (lo + deps.random() * Math.max(0, hi - lo)) * MINUTE);
    for (const bot of await activeBots(deps.db)) {
      const member = await this.wantsMemberPeek(bot, now);
      const moderation = await this.wantsModerationPeek(bot, now);
      if (!member && !moderation) continue;
      const token = deps.secret(bot.boardTokenRef);
      if (!token) continue;
      let board: BoardSession | null = null;
      try {
        board = await deps.connectBoard(token);
        const peek = (since: Date | null) =>
          callJson<InboxJson>(board!, "get_inbox", { ...(since ? { since: since.toISOString() } : {}), peek: true });
        if (member) {
          const reason = earlyWakeReason(await peek(bot.inboxCursor), bot.inboxCursor);
          if (reason) {
            const at = soon();
            await updateState(deps.db, bot.userId, { earlyWakeAt: at, earlyWakeTrigger: "early" });
            deps.log(`${bot.username} will wake early at ${at.toISOString()}: ${reason}.`);
          }
        }
        if (moderation) {
          const reason = moderationReason(await peek(bot.modCursor), bot.modCursor, { patrol: false });
          if (reason) {
            const last = await lastModerationAt(deps.db, bot.userId);
            const gap = last ? new Date(last.getTime() + config.runner.moderation_min_gap_minutes * MINUTE) : now;
            const at = new Date(Math.max(soon().getTime(), gap.getTime()));
            await updateState(deps.db, bot.userId, { modEarlyAt: at, modEarlyTrigger: "early" });
            deps.log(`${bot.username} will moderate at ${at.toISOString()}: ${reason}.`);
          }
        }
      } catch (err) {
        deps.log(`Early-wake check for ${bot.username} failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        await board?.close().catch(() => {});
      }
    }
  }
}
