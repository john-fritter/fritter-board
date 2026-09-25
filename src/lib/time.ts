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
