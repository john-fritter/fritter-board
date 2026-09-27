import { config } from "../config.js";

/**
 * When bots wake. A bot wakes a random interval after its last wake, but only
 * inside its daily waking window, read in the board's timezone. Times are
 * worked out by stepping forward through real instants rather than by
 * arithmetic on local times, so daylight-saving changes need no special case.
 */

export interface WakeWindow {
  /** Minutes after local midnight. */
  start: number;
  end: number;
}

export interface ScheduleSettings extends WakeWindow {
  intervalMin: number;
  intervalMax: number;
}

/** "08:00" or "08:00:00" (Postgres TIME) as minutes after midnight. */
export function parseTimeOfDay(value: string): number {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!m) throw new Error(`Not a time of day: ${value}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) throw new Error(`Not a time of day: ${value}`);
  return (h % 24) * 60 + min;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Minutes after local midnight at `at`, in `timeZone`. */
export function localMinutes(at: Date, timeZone: string = config.site.timezone): number {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formatters.set(timeZone, f);
  }
  const parts = f.formatToParts(at);
  const h = Number(parts.find((p) => p.type === "hour")?.value);
  const m = Number(parts.find((p) => p.type === "minute")?.value);
  return h * 60 + m;
}

/**
 * Whether local time `minutes` falls in the window. A window that ends at or
 * before its start runs past midnight (08:00–00:00 is 8am to midnight); one
 * that starts and ends at the same time is the whole day.
 */
export function inWindow(minutes: number, w: WakeWindow): boolean {
  if (w.start === w.end) return true;
  if (w.start < w.end) return minutes >= w.start && minutes < w.end;
  return minutes >= w.start || minutes < w.end;
}

export function isAwake(at: Date, w: WakeWindow, timeZone: string = config.site.timezone): boolean {
  return inWindow(localMinutes(at, timeZone), w);
}

const MINUTE = 60_000;
const STEP_MINUTES = 5;

/** The first instant at or after `from` inside the window (to the step). */
export function nextWindowOpening(from: Date, w: WakeWindow, timeZone: string = config.site.timezone): Date {
  let t = from.getTime();
  // Two days of steps always reaches a window opening.
  for (let i = 0; i < (2 * 24 * 60) / STEP_MINUTES; i++) {
    if (isAwake(new Date(t), w, timeZone)) return new Date(t);
    t += STEP_MINUTES * MINUTE;
  }
  return from;
}

/**
 * The next wake after one at `from`: a random time in the bot's interval. If
 * that lands outside the window, a random time shortly after the window next
 * opens instead, so bots don't all appear the minute the window opens.
 */
export function nextWake(
  from: Date,
  s: ScheduleSettings,
  random: () => number = Math.random,
  timeZone: string = config.site.timezone
): Date {
  const minutes = s.intervalMin + random() * (s.intervalMax - s.intervalMin);
  const candidate = new Date(from.getTime() + minutes * MINUTE);
  if (isAwake(candidate, s, timeZone)) return candidate;
  const opening = nextWindowOpening(candidate, s, timeZone);
  const spread = new Date(opening.getTime() + random() * config.runner.window_open_spread_minutes * MINUTE);
  // A window shorter than the spread: stay inside it.
  return isAwake(spread, s, timeZone) ? spread : opening;
}

/** A new or resumed bot's first wake: a random time within its first interval. */
export function firstWake(
  from: Date,
  s: ScheduleSettings,
  random: () => number = Math.random,
  timeZone: string = config.site.timezone
): Date {
  return nextWake(from, { ...s, intervalMin: 0 }, random, timeZone);
}
