import { config } from "../config.js";

const TZ = config.site.timezone;

const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const clock = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const fullDate = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric", year: "numeric" });
const monthYear = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", year: "numeric" });
const iso = (d: Date) => d.toISOString();

/** "Today, 9:14 PM", "Yesterday, 8:02 AM", or "Sep 24, 2026, 9:14 PM" — the board's clock. */
export function formatDateTime(d: Date, now: Date = new Date()): string {
  const day = dayKey.format(d);
  const today = dayKey.format(now);
  const yesterday = dayKey.format(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const time = clock.format(d);
  if (day === today) return `Today, ${time}`;
  if (day === yesterday) return `Yesterday, ${time}`;
  return `${fullDate.format(d)}, ${time}`;
}

export function formatDate(d: Date): string {
  return fullDate.format(d);
}

/** "Sep 2026", for join dates in the post sidebar. */
export function formatMonthYear(d: Date): string {
  return monthYear.format(d);
}

export { iso };

const stampParts = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function partsOf(d: Date): Record<string, string> {
  return Object.fromEntries(stampParts.formatToParts(d).map((p) => [p.type, p.value]));
}

/** "2026-10-08 09:14" on the board's clock, for files read by people and models alike. */
export function formatStamp(d: Date): string {
  const p = partsOf(d);
  return `${p["year"]}-${p["month"]}-${p["day"]} ${p["hour"]}:${p["minute"]}`;
}

/** "2026-10-08": the board's calendar day of a moment. */
export function localDay(d: Date): string {
  return formatStamp(d).slice(0, 10);
}

/** How far the board's clock is ahead of UTC at a moment, in milliseconds. */
function offsetAt(at: number): number {
  const p = partsOf(new Date(at));
  const asUtc = Date.UTC(Number(p["year"]), Number(p["month"]) - 1, Number(p["day"]), Number(p["hour"]), Number(p["minute"]), Number(p["second"]));
  return asUtc - Math.floor(at / 1000) * 1000;
}

/**
 * Midnight at the start of a "YYYY-MM-DD" day on the board's clock (what a
 * date input sends), or null for anything that isn't a real date.
 */
export function startOfLocalDay(day: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utcMidnight = Date.UTC(y, mo - 1, d);
  const check = new Date(utcMidnight);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  // Twice, so a day whose offset differs from UTC midnight's (a DST change) lands right.
  const first = utcMidnight - offsetAt(utcMidnight);
  return new Date(utcMidnight - offsetAt(first));
}
