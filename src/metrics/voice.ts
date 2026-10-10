/**
 * Voice metrics: how the board sounds, per member and board-wide, so a change
 * to the bots' briefs, personas or posting rules can be compared with what
 * came before (npm run voice-metrics). It measures what's on the page and
 * reads nothing about bots beyond the BOT badge every visitor sees.
 *
 * The measures, from the 2026-10-10 review of the archive: post length, the
 * share of posts that open with a quote, how often house phrases
 * (config/voice-metrics.yaml) turn up and in how many threads, which boards
 * each member posts in, and the most posts a member made in one thread on
 * one day. Length and phrases count a post's own words only: quotes removed.
 * Private messages aren't posts and aren't counted.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { Db } from "../db/index.js";
import { visibleBoardsSql } from "../forum/permissions.js";
import { stripQuotes } from "../markup/bbcode.js";

export interface MetricPost {
  id: number;
  author: string;
  isBot: boolean;
  board: string;
  threadId: number;
  /** The post that opened its thread. */
  isFirst: boolean;
  /** On the board's clock, "YYYY-MM-DD HH:MM", so dates compare as strings. */
  at: string;
  body: string;
  removed: boolean;
}

export interface Phrase {
  name: string;
  pattern: RegExp;
}

export const PHRASES_FILE = path.join(import.meta.dirname, "..", "..", "config", "voice-metrics.yaml");

const PhrasesSchema = z.object({
  phrases: z.array(z.object({ name: z.string().min(1), pattern: z.string().min(1) })).min(1),
});

export function loadPhrases(file = PHRASES_FILE): Phrase[] {
  const { phrases } = PhrasesSchema.parse(YAML.parse(readFileSync(file, "utf-8")));
  return phrases.map((p) => ({ name: p.name, pattern: new RegExp(p.pattern, "i") }));
}

/** A post's own words: quotes removed, formatting tags dropped, apostrophes straightened. */
export function ownText(body: string): string {
  return stripQuotes(body)
    .replace(/\[\/?(?:b|i|u|s|code|list|\*)\]/gi, "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function opensWithQuote(body: string): boolean {
  return /^\s*\[quote\b/i.test(body);
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

export interface MemberRow {
  name: string;
  isBot: boolean;
  posts: number;
  removed: number;
  threadsStarted: number;
  medianChars: number;
  p90Chars: number;
  medianWords: number;
  /** Shares of the member's posts, 0 to 1. */
  quoteOpen: number;
  anyQuote: number;
  question: number;
  /** Posts with at least one house phrase. */
  withPhrase: number;
  /** Phrase name → posts using it, most used first. */
  phrases: [string, number][];
  /** Board name → posts, in board order. */
  boards: [string, number][];
  /** The most posts the member made in one thread on one day. */
  maxThreadDay: number;
}

export interface PhraseRow {
  name: string;
  /** Bot posts using it, and their share of all bot posts. */
  botPosts: number;
  botShare: number;
  /** Per 1,000 words of bots' own text. */
  per1000Words: number;
  bots: number;
  threads: number;
  /** The bots using it most, with counts. */
  top: [string, number][];
}

export interface BoardRow {
  name: string;
  threads: number;
  posts: number;
  botPosts: number;
  botThreads: number;
}

export interface WeekRow extends MemberRow {
  /** The Monday the week starts on, "YYYY-MM-DD". */
  week: string;
}

export interface VoiceReport {
  source: string;
  since: string | null;
  until: string | null;
  first: string | null;
  last: string | null;
  members: MemberRow[];
  allBots: MemberRow;
  everyone: MemberRow;
  phrases: PhraseRow[];
  boards: BoardRow[];
  /** Bot posts week by week, to show drift. */
  weeks: WeekRow[];
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return Math.round(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo));
}

/** The Monday on or before a "YYYY-MM-DD…" date. */
export function weekOf(at: string): string {
  const d = new Date(`${at.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function byCount(m: Map<string, number>): [string, number][] {
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

interface Measured {
  post: MetricPost;
  chars: number;
  words: number;
  phrases: string[];
}

function measurePost(post: MetricPost, phrases: Phrase[]): Measured {
  const text = ownText(post.body);
  return {
    post,
    chars: text.length,
    words: wordCount(text),
    phrases: phrases.filter((p) => p.pattern.test(text)).map((p) => p.name),
  };
}

function memberRow(name: string, isBot: boolean, ms: Measured[], boardOrder: string[]): MemberRow {
  const n = ms.length;
  const share = (pred: (m: Measured) => boolean) => (n === 0 ? 0 : ms.filter(pred).length / n);
  const chars = ms.map((m) => m.chars).sort((a, b) => a - b);
  const words = ms.map((m) => m.words).sort((a, b) => a - b);

  const phrases = new Map<string, number>();
  for (const m of ms) for (const p of m.phrases) phrases.set(p, (phrases.get(p) ?? 0) + 1);

  const boards = new Map<string, number>();
  for (const m of ms) boards.set(m.post.board, (boards.get(m.post.board) ?? 0) + 1);

  const threadDays = new Map<string, number>();
  for (const m of ms) {
    const key = `${m.post.author}\n${m.post.threadId}\n${m.post.at.slice(0, 10)}`;
    threadDays.set(key, (threadDays.get(key) ?? 0) + 1);
  }

  return {
    name,
    isBot,
    posts: n,
    removed: ms.filter((m) => m.post.removed).length,
    threadsStarted: ms.filter((m) => m.post.isFirst).length,
    medianChars: quantile(chars, 0.5),
    p90Chars: quantile(chars, 0.9),
    medianWords: quantile(words, 0.5),
    quoteOpen: share((m) => opensWithQuote(m.post.body)),
    anyQuote: share((m) => /\[quote\b/i.test(m.post.body)),
    question: share((m) => ownText(m.post.body).includes("?")),
    withPhrase: share((m) => m.phrases.length > 0),
    phrases: byCount(phrases),
    boards: boardOrder.filter((b) => boards.has(b)).map((b) => [b, boards.get(b)!]),
    maxThreadDay: Math.max(0, ...threadDays.values()),
  };
}

export interface MeasureOptions {
  source: string;
  /** Inclusive, "YYYY-MM-DD" (or longer). */
  since?: string | null;
  /** Exclusive. */
  until?: string | null;
  /** Every board, in display order, empty ones included. */
  boards: string[];
}

export function measure(all: MetricPost[], phrases: Phrase[], opts: MeasureOptions): VoiceReport {
  const since = opts.since ?? null;
  const until = opts.until ?? null;
  const posts = all.filter((p) => (since === null || p.at >= since) && (until === null || p.at < until));
  const ms = posts.map((p) => measurePost(p, phrases));
  const boardOrder = [...opts.boards, ...new Set(posts.map((p) => p.board).filter((b) => !opts.boards.includes(b)))];

  const byAuthor = new Map<string, Measured[]>();
  for (const m of ms) byAuthor.set(m.post.author, [...(byAuthor.get(m.post.author) ?? []), m]);
  const members = [...byAuthor]
    .map(([name, mine]) => memberRow(name, mine[0]!.post.isBot, mine, boardOrder))
    .sort((a, b) => b.posts - a.posts || a.name.localeCompare(b.name));

  const botMs = ms.filter((m) => m.post.isBot);
  const botWords = botMs.reduce((s, m) => s + m.words, 0);
  const phraseRows = phrases.map((ph): PhraseRow => {
    const using = botMs.filter((m) => m.phrases.includes(ph.name));
    const perBot = new Map<string, number>();
    for (const m of using) perBot.set(m.post.author, (perBot.get(m.post.author) ?? 0) + 1);
    return {
      name: ph.name,
      botPosts: using.length,
      botShare: botMs.length === 0 ? 0 : using.length / botMs.length,
      per1000Words: botWords === 0 ? 0 : (using.length * 1000) / botWords,
      bots: perBot.size,
      threads: new Set(using.map((m) => m.post.threadId)).size,
      top: byCount(perBot).slice(0, 3),
    };
  });

  const boardRows = boardOrder.map((name): BoardRow => {
    const here = posts.filter((p) => p.board === name);
    return {
      name,
      threads: here.filter((p) => p.isFirst).length,
      posts: here.length,
      botPosts: here.filter((p) => p.isBot).length,
      botThreads: here.filter((p) => p.isFirst && p.isBot).length,
    };
  });

  const byWeek = new Map<string, Measured[]>();
  for (const m of botMs) byWeek.set(weekOf(m.post.at), [...(byWeek.get(weekOf(m.post.at)) ?? []), m]);
  const weeks = [...byWeek]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, mine]): WeekRow => ({ week, ...memberRow(`Week of ${week}`, true, mine, boardOrder) }));

  const times = posts.map((p) => p.at).sort();
  return {
    source: opts.source,
    since,
    until,
    first: times[0] ?? null,
    last: times[times.length - 1] ?? null,
    members,
    allBots: memberRow("All bots", true, botMs, boardOrder),
    everyone: memberRow("Everyone", false, ms, boardOrder),
    phrases: phraseRows,
    boards: boardRows,
    weeks,
  };
}

// ── The report ──────────────────────────────────────────────────────────

const pct = (x: number) => `${Math.round(x * 100)}%`;
const num = (x: number) => x.toLocaleString("en-US");

function cells(row: (string | number)[]): string {
  return `| ${row.join(" | ")} |`;
}

export function renderReport(r: VoiceReport): string {
  const out: string[] = [];
  const window = [r.since ? `from ${r.since}` : null, r.until ? `until ${r.until}` : null].filter(Boolean).join(" ");
  out.push("# Voice metrics", "");
  out.push(`Source: ${r.source}. Posts ${window || "of every date"}${r.first ? `, ${r.first} to ${r.last}` : ""}. ` +
    "Visible boards only (no Back Room), removed posts included, private messages left out. " +
    "Lengths and phrases count each post's own words, with quotes removed.", "");

  out.push("## Members", "");
  out.push(cells(["Member", "Posts", "Threads started", "Median chars", "90th pct chars", "Median words",
    "Opens with quote", "Any quote", "Asks a question", "House phrase", "Most in one thread-day", "Removed"]));
  out.push(cells(Array(12).fill("---")));
  for (const m of [...r.members, r.allBots, r.everyone]) {
    const name = m === r.allBots || m === r.everyone ? `**${m.name}**` : m.isBot ? `${m.name} (bot)` : m.name;
    out.push(cells([name, m.posts, m.threadsStarted, num(m.medianChars), num(m.p90Chars), num(m.medianWords),
      pct(m.quoteOpen), pct(m.anyQuote), pct(m.question), pct(m.withPhrase), m.maxThreadDay, m.removed]));
  }
  out.push("");

  out.push("## Where each member posts", "");
  out.push(cells(["Member", ...r.boards.map((b) => b.name)]));
  out.push(cells(Array(r.boards.length + 1).fill("---")));
  for (const m of [...r.members, r.allBots]) {
    const counts = new Map(m.boards);
    out.push(cells([m.name, ...r.boards.map((b) => counts.get(b.name) ?? 0)]));
  }
  out.push("");

  out.push("## Boards", "");
  out.push(cells(["Board", "Threads started", "By bots", "Posts", "By bots"]));
  out.push(cells(Array(5).fill("---")));
  for (const b of r.boards) out.push(cells([b.name, b.threads, b.botThreads, b.posts, b.botPosts]));
  out.push("");

  out.push("## Bot posts by week", "");
  out.push(cells(["Week of", "Posts", "Median chars", "Opens with quote", "Asks a question", "House phrase",
    "Threads started", ...r.boards.map((b) => b.name)]));
  out.push(cells(Array(r.boards.length + 7).fill("---")));
  for (const w of r.weeks) {
    const counts = new Map(w.boards);
    out.push(cells([w.week, w.posts, num(w.medianChars), pct(w.quoteOpen), pct(w.question), pct(w.withPhrase),
      w.threadsStarted, ...r.boards.map((b) => counts.get(b.name) ?? 0)]));
  }
  out.push("");

  out.push("## House phrases (bot posts)", "");
  out.push(cells(["Phrase", "Bot posts", "Share", "Per 1,000 words", "Bots", "Threads", "Most by"]));
  out.push(cells(Array(7).fill("---")));
  for (const p of r.phrases) {
    out.push(cells([p.name, p.botPosts, pct(p.botShare), p.per1000Words.toFixed(2), p.bots, p.threads,
      p.top.map(([who, n]) => `${who} ${n}`).join(", ") || "–"]));
  }
  out.push("");

  out.push("## Each bot's phrases", "");
  for (const m of r.members.filter((m) => m.isBot)) {
    out.push(`- **${m.name}:** ${m.phrases.map(([p, n]) => `${p} ${n}`).join(", ") || "none"}`);
  }
  out.push("");
  return out.join("\n");
}

// ── Reading the board ───────────────────────────────────────────────────

/**
 * Every post on the live board as an anonymous visitor would see it: no Back
 * Room, as the archive export has none, so both sources measure the same
 * posts. Removed posts are kept (the archive keeps their text too). Dates are
 * on the board's clock.
 */
export async function loadBoardPosts(db: Db, timezone: string): Promise<{ posts: MetricPost[]; boards: string[] }> {
  const boards = await db.query<{ name: string }>(
    `SELECT b.name FROM boards b JOIN categories c ON c.id = b.category_id
      WHERE ${visibleBoardsSql(null)} AND c.deleted_at IS NULL
      ORDER BY c.sort_order, c.id, b.sort_order, b.id`
  );
  const posts = await db.query<MetricPost>(
    `SELECT p.id, u.username AS author, u.is_bot AS "isBot", b.name AS board, t.id AS "threadId",
            t.first_post_id = p.id AS "isFirst",
            to_char(p.created_at AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS at,
            p.body, p.deleted_at IS NOT NULL AS removed
       FROM posts p
       JOIN threads t ON t.id = p.thread_id
       JOIN boards b ON b.id = t.board_id
       JOIN users u ON u.id = p.author_id
      WHERE t.deleted_at IS NULL AND ${visibleBoardsSql(null)}
      ORDER BY p.id`,
    [timezone]
  );
  return { posts: posts.rows, boards: boards.rows.map((r) => r.name) };
}

// ── Reading an archive export ───────────────────────────────────────────

/**
 * Posts from the board's Markdown archive (the export "Fritter Board: the
 * archive"). Threads are `### "title"` followed by a `Board:` line; posts are
 * `#### #N · author · YYYY-MM-DD HH:MM · post ID`; a removed post's text
 * follows a `*[Removed by …]*` line. Bodies can hold Markdown headings of
 * their own, so only those exact shapes start a thread or post, and the
 * thread list ends at the private messages or the moderation log.
 */
export function parseArchive(md: string): { posts: MetricPost[]; boards: string[] } {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const boards: string[] = [];
  const posts: MetricPost[] = [];
  let section = "";
  let board: string | null = null;
  let threadId = 0;
  let current: MetricPost | null = null;
  let body: string[] = [];

  const finish = () => {
    if (current) {
      let text = body.join("\n").trim();
      const removed = /^\*\[Removed by [^\n]*\]\*\s*/.exec(text);
      if (removed) {
        current.removed = true;
        text = text.slice(removed[0].length);
      }
      current.body = text;
      posts.push(current);
    }
    current = null;
    body = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const top = /^## (Boards|Members|Threads|Private messages|Moderation log|Reports)\b/.exec(line);
    if (top && (section !== "Threads" || /^(Private messages|Moderation log|Reports)$/.test(top[1]!))) {
      finish();
      section = top[1]!;
      continue;
    }
    if (section === "Boards") {
      const b = /^- (.+?) \([^)]*\): /.exec(line);
      if (b) boards.push(b[1]!);
      continue;
    }
    if (section !== "Threads") continue;

    const next = lines.slice(i + 1).find((l) => l.trim() !== "") ?? "";
    const threadLine = /^Board: (.+?) · started by .+? · thread (\d+) ·/.exec(next);
    if (/^### "/.test(line) && threadLine) {
      finish();
      board = threadLine[1]!;
      threadId = Number(threadLine[2]);
      continue;
    }
    if (/^Board: .+ · thread \d+ ·/.test(line) && current === null) continue;

    const head = /^#### #(\d+) · (.+?) · (\d{4}-\d\d-\d\d \d\d:\d\d) · post (\d+)(?: · .*)?$/.exec(line);
    if (head && board !== null) {
      finish();
      const bot = / \(bot\)$/.test(head[2]!);
      current = {
        id: Number(head[4]),
        author: head[2]!.replace(/ \(bot\)$/, ""),
        isBot: bot,
        board,
        threadId,
        isFirst: head[1] === "1",
        at: head[3]!,
        body: "",
        removed: false,
      };
      continue;
    }
    if (current) body.push(line);
  }
  finish();
  return { posts, boards };
}
