import { config } from "../config.js";
import type { InboxJson } from "./board.js";
import type { Db } from "./store.js";

/**
 * The visit diary: one entry a visit, written by the runner from what the
 * bot did, with no model call. It's the bot's record of where it has been
 * (the Generative Agents "observation stream", built from the run instead of
 * a model), so its notes are free for opinions and impressions. The newest
 * entries come with every visit, `recall` searches them all, and the weekly
 * reflection reads the ones since the last.
 */

export interface DiaryEntry {
  id: number;
  body: string;
  createdAt: Date;
}

interface DiaryRow {
  id: number;
  body: string;
  created_at: Date;
}

const toEntry = (r: DiaryRow): DiaryEntry => ({ id: r.id, body: r.body, createdAt: r.created_at });

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const quoted = (s: string) => `“${s}”`;

/**
 * What a post says in its own words, its opening and its ending when it's
 * longer than `max`: quoted posts and code left out, BBCode tags taken off,
 * whitespace collapsed. The ending is there so a bot reading its diary sees
 * how its posts end as well as how they start, where its habits show.
 */
export function postExcerpt(body: string, max: number = config.runner.diary_excerpt_chars): string {
  let text = body;
  // Innermost quotes first, so nested ones go too.
  for (let prev = ""; prev !== text; ) {
    prev = text;
    text = text.replace(/\[quote(?:=[^\]]*)?\](?:(?!\[quote)[\s\S])*?\[\/quote\]/gi, " ");
  }
  text = text
    .replace(/\[code\][\s\S]*?\[\/code\]/gi, " … ")
    .replace(/\[\/?[a-z*]+(?:=[^\]\n]*)?\]/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/ ([,.;:!?])/g, "$1")
    .trim();
  if (text.length <= max) return text;
  const headMax = Math.floor(max * 0.6);
  const tailMax = max - headMax - 3;
  let head = text.slice(0, headMax);
  if (/\S/.test(text[headMax] ?? "") && head.includes(" ")) head = head.slice(0, head.lastIndexOf(" "));
  let tail = text.slice(text.length - tailMax);
  if (/\S/.test(text[text.length - tailMax - 1] ?? "") && tail.includes(" ")) tail = tail.slice(tail.indexOf(" ") + 1);
  return `${head.trimEnd()} … ${tail.trimStart()}`;
}

/** Whose posts a post quotes, in order, from its [quote="Name" …] blocks. */
export function quotedNames(body: string): string[] {
  const names: string[] = [];
  for (const m of body.matchAll(/\[quote=(?:"([^"\]]+)"|([^\s\]]+))/gi)) {
    const name = (m[1] ?? m[2] ?? "").trim();
    if (name && !names.some((n) => n.toLowerCase() === name.toLowerCase())) names.push(name);
  }
  return names;
}

const list = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/**
 * What a visit did, gathered as it goes: the runner tells it about each
 * tool call that succeeded, and it turns them into one diary entry.
 */
export class VisitDiary {
  private readonly titles = new Map<number, string>();
  private readonly pmWith = new Map<number, string[]>();
  private readonly articles = new Map<number, string>();
  /** Things the bot read, in order, each once. */
  private readonly reads: string[] = [];
  /** Range of post numbers read, per thread, in the order first read. */
  private readonly threadsRead = new Map<number, { from: number; to: number; summary: number | null }>();
  private readonly done: string[] = [];
  /** Notes written, and who they were about. */
  private notes = 0;
  private readonly notesAbout: string[] = [];

  /** `self`: the bot's own name, left out of whom it talked with. */
  constructor(private readonly self: string = "") {}

  learnInbox(inbox: InboxJson): void {
    for (const p of [...inbox.replies, ...inbox.mentions]) this.titles.set(p.thread_id, p.thread);
    for (const t of inbox.active_threads) this.titles.set(t.thread_id, t.title);
    for (const c of inbox.unread_pms) this.pmWith.set(c.conversation_id, c.with);
    if (Array.isArray(inbox.new_articles)) for (const a of inbox.new_articles) this.articles.set(a.fp_article_id, a.title);
  }

  private thread(id: number): string {
    const title = this.titles.get(id);
    return title ? `${quoted(title)} (thread ${id})` : `thread ${id}`;
  }

  private read(what: string): void {
    if (!this.reads.includes(what)) this.reads.push(what);
  }

  /** A tool call that succeeded: its name, its arguments, and the text it returned. */
  observe(tool: string, args: Record<string, unknown>, result: string): void {
    let json: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(result);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
    } catch {
      // Not JSON: the arguments are enough.
    }
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const num = (v: unknown) => (typeof v === "number" ? v : Number.isSafeInteger(Number(v)) && v !== null && v !== "" ? Number(v) : null);
    const body = str(args["body"]);
    const said = () => {
      const excerpt = postExcerpt(body);
      return excerpt ? `: ${quoted(excerpt)}` : "";
    };

    switch (tool) {
      case "read_thread": {
        const t = json["thread"] as { thread_id?: number; title?: string } | undefined;
        const posts = (json["posts"] as { number?: number }[] | undefined) ?? [];
        const id = t?.thread_id;
        if (!id) return;
        if (t.title) this.titles.set(id, t.title);
        const numbers = posts.map((p) => p.number).filter((n): n is number => typeof n === "number");
        const summary = (json["summary_of_earlier_posts"] as { through_post?: number } | undefined)?.through_post ?? null;
        const seen = this.threadsRead.get(id);
        const from = Math.min(seen?.from ?? Infinity, ...numbers, summary ? 1 : Infinity);
        const to = Math.max(seen?.to ?? 0, ...numbers);
        this.threadsRead.set(id, { from, to, summary: summary ?? seen?.summary ?? null });
        return;
      }
      case "list_threads": {
        const b = json["board"] as { slug?: string; name?: string } | undefined;
        for (const th of (json["threads"] as { thread_id?: number; title?: string }[] | undefined) ?? []) {
          if (th.thread_id && th.title) this.titles.set(th.thread_id, th.title);
        }
        if (b?.name || b?.slug) this.read(`the ${b.name ?? b.slug} board's thread list`);
        return;
      }
      case "read_pms": {
        const id = num(json["conversation_id"]);
        const who = ((json["participants"] as string[] | undefined) ?? []).filter((n) => n.toLowerCase() !== this.self.toLowerCase());
        if (id !== null && who.length) this.pmWith.set(id, who);
        this.read(id !== null && who.length ? `your messages with ${list(who)}` : "your private messages");
        return;
      }
      case "read_article": {
        const id = num(args["fp_article_id"]);
        const title = str(json["headline"]) || (id !== null ? this.articles.get(id) : undefined);
        this.read(title ? `the article ${quoted(title)}` : `article ${String(args["fp_article_id"])}`);
        return;
      }
      case "get_user":
        this.read(`${str(json["name"]) || str(args["username"])}'s profile`);
        return;
      case "search":
        this.read(`a board search for ${quoted(str(args["query"]) || str(args["author"]))}`);
        return;
      case "web_search":
        this.done.push(`looked up ${quoted(str(args["query"]))} on the web`);
        return;
      case "recall":
        return;
      case "remember": {
        this.notes++;
        const about = str(json["about"]);
        if (about && !this.notesAbout.includes(about)) this.notesAbout.push(about);
        return;
      }
      case "reply": {
        const id = num(args["thread_id"]);
        const names = quotedNames(body);
        this.done.push(`replied in ${id === null ? "a thread" : this.thread(id)}${names.length ? `, quoting ${list(names)}` : ""}${said()}`);
        return;
      }
      case "new_thread": {
        const id = num(json["thread_id"]);
        const title = str(args["title"]);
        if (id !== null && title) this.titles.set(id, title);
        const where = str(args["board"]) || (args["fp_article_id"] ? config.fritter_post.discussion_board : "");
        this.done.push(`started ${id === null ? quoted(title) : this.thread(id)}${where ? ` in ${where}` : ""}${said()}`);
        return;
      }
      case "send_pm": {
        const id = num(args["conversation_id"]) ?? num(json["conversation_id"]);
        const to = str(args["to"]);
        const who = to ? [to] : id !== null ? (this.pmWith.get(id) ?? []) : [];
        this.done.push(`${to ? "sent" : "answered"} a private message${who.length ? ` ${to ? "to" : "from"} ${list(who)}` : ""}${said()}`);
        return;
      }
      case "edit_post":
        this.done.push(`edited your post ${String(args["post_id"])}${said()}`);
        return;
      case "report_post":
        this.done.push(`reported post ${String(args["post_id"])}`);
        return;
      default:
        return;
    }
  }

  /** The entry, or null if the visit did nothing worth a line. */
  entry(): string | null {
    const reads = [
      ...[...this.threadsRead].map(([id, r]) => {
        const span = r.from === r.to ? `#${r.from}` : `#${r.from}–${r.to}`;
        return `${this.thread(id)}, ${span}${r.summary ? `, the first ${r.summary} as a summary` : ""}`;
      }),
      ...this.reads,
    ];
    const done = [...this.done];
    if (this.notes) {
      done.push(`wrote ${this.notes === 1 ? "a note" : `${this.notes} notes`}${this.notesAbout.length ? `, about ${list(this.notesAbout)}` : ""}`);
    }
    const parts: string[] = [];
    if (reads.length) parts.push(`Read ${reads.join("; ")}.`);
    // A sentence ending in a quoted post's own full stop needs no other.
    const sentence = (d: string) => `${d[0]!.toUpperCase()}${d.slice(1)}${/[.!?…]”$/.test(d) ? "" : "."}`;
    if (done.length) parts.push(done.map(sentence).join(" "));
    if (parts.length === 0) return null;
    if (!this.done.some((d) => /^(replied|started|sent|answered)/.test(d))) parts.push("Posted nothing.");
    return clip(parts.join(" "), config.runner.diary_entry_max_chars);
  }
}

export async function insertDiary(db: Db, userId: number, runId: number | null, body: string, createdAt: Date | null = null): Promise<number> {
  // createdAt dates an entry backfilled from an old visit; a live one is now.
  const { rows } = await db.query<{ id: number }>(
    "INSERT INTO bots.diary (user_id, run_id, body, created_at) VALUES ($1, $2, $3, COALESCE($4, now())) RETURNING id",
    [userId, runId, body, createdAt]
  );
  return rows[0]!.id;
}

/** The newest entries since `since`, at most `limit`, oldest first. */
export async function recentDiary(db: Db, userId: number, since: Date, limit: number = config.runner.diary_recent_entries): Promise<DiaryEntry[]> {
  const { rows } = await db.query<DiaryRow>(
    `SELECT * FROM (
       SELECT id, body, created_at FROM bots.diary WHERE user_id = $1 AND created_at >= $2
        ORDER BY created_at DESC, id DESC LIMIT $3
     ) d ORDER BY created_at, id`,
    [userId, since, limit]
  );
  return rows.map(toEntry);
}

/** Entries since `since` (all, with null), oldest first, as many of the newest as fit in `maxChars`. */
export async function diarySince(db: Db, userId: number, since: Date | null, maxChars: number): Promise<DiaryEntry[]> {
  const { rows } = await db.query<DiaryRow>(
    `SELECT id, body, created_at FROM bots.diary WHERE user_id = $1 AND ($2::timestamptz IS NULL OR created_at >= $2)
      ORDER BY created_at DESC, id DESC`,
    [userId, since]
  );
  const out: DiaryEntry[] = [];
  let size = 0;
  for (const r of rows) {
    size += r.body.length;
    if (out.length > 0 && size > maxChars) break;
    out.push(toEntry(r));
  }
  return out.reverse();
}

/** When the oldest entry since `since` (all, with null) was written, or null if there's none. */
export async function diaryOldest(db: Db, userId: number, since: Date | null): Promise<Date | null> {
  const { rows } = await db.query<{ at: Date | null }>(
    "SELECT MIN(created_at) AS at FROM bots.diary WHERE user_id = $1 AND ($2::timestamptz IS NULL OR created_at >= $2)",
    [userId, since]
  );
  return rows[0]?.at ?? null;
}

/**
 * `recall`'s search of the diary: entries matching words (Postgres full
 * text), naming a member, both, or neither (the latest); newest first.
 */
export async function searchDiary(db: Db, userId: number, query: string, about: string, limit: number): Promise<DiaryEntry[]> {
  const where = ["user_id = $1"];
  const params: unknown[] = [userId];
  if (query) {
    params.push(query);
    where.push(`search_vector @@ websearch_to_tsquery('english', $${params.length})`);
  }
  if (about) {
    params.push(`%${about.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where.push(`body ILIKE $${params.length}`);
  }
  params.push(limit);
  const { rows } = await db.query<DiaryRow>(
    `SELECT id, body, created_at FROM bots.diary WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params
  );
  return rows.map(toEntry);
}

const when = new Intl.DateTimeFormat("en-US", {
  timeZone: config.site.timezone,
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** An entry as one line: "Fri, Oct 9, 8:14 PM: Read …". */
export function diaryLine(e: DiaryEntry): string {
  return `${when.format(e.createdAt)}: ${e.body}`;
}
