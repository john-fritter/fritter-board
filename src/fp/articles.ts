import { Pool } from "pg";

/**
 * Read-only access to Fritter Post's published articles.
 *
 * The board reads the paper only through Fritter Post's `published` schema: two
 * views that are the whole contract, owned and migrated by Fritter Post (its
 * migration 046). The board's role is granted that schema and nothing else, so
 * it cannot see the pipeline's tables, and this pool is also read-only at the
 * session level, so a mistake here fails rather than writes.
 *
 * An article id is Fritter Post's writer_pieces.id. It survives a re-publish
 * of the same morning; a paper replaced from a different run takes its ids
 * with it, so an id can stop resolving (the thread keeps going) but never
 * comes back as a different story.
 *
 * No article text is copied into the board. Cards read it live.
 */

export interface FpArticle {
  id: number;
  /** The edition date, "YYYY-MM-DD". */
  publishedOn: string;
  /** Null for a section line, which is a single sentence with no headline. */
  headline: string | null;
  body: string;
  /** The section a piece belongs to, when it is part of one. */
  sectionTitle: string | null;
  wordCount: number;
  sourceCount: number;
}

export function createFpPool(url: string): Pool {
  return new Pool({
    connectionString: url,
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    options: "-c search_path=published -c default_transaction_read_only=on",
  });
}

export async function getArticle(fp: Pool, id: number): Promise<FpArticle | null> {
  const { rows } = await fp.query<{
    id: number;
    published_on: string;
    headline: string | null;
    body: string;
    section_title: string | null;
    word_count: number;
    source_count: number;
  }>(
    // The date as text: pg would otherwise parse it into a local-midnight Date.
    `SELECT id, to_char(published_on, 'YYYY-MM-DD') AS published_on, headline, body,
            section_title, word_count, source_count
       FROM articles WHERE id = $1`,
    [id]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: Number(r.id),
    publishedOn: r.published_on,
    headline: r.headline,
    body: r.body,
    sectionTitle: r.section_title,
    wordCount: r.word_count,
    sourceCount: r.source_count,
  };
}

/** What a piece leads on: its headline, or a section line's sentence. */
export function articleTitle(a: Pick<FpArticle, "headline" | "body">): string {
  const headline = a.headline?.trim();
  return headline ? headline : a.body.trim().replace(/\s+/g, " ");
}

/**
 * The card's standfirst: the first paragraph, cut at a word boundary. Null for
 * a section line, whose one sentence is already the title. Deliberately not
 * "the first sentence": a period-plus-space ends "U.S." as readily as a clause.
 */
export function articleDek(a: Pick<FpArticle, "headline" | "body">, maxChars: number): string | null {
  if (!a.headline?.trim()) return null;
  const first = a.body.split(/\n\s*\n/).map((p) => p.trim().replace(/\s+/g, " ")).find((p) => p.length > 0);
  if (!first) return null;
  return clip(first, maxChars);
}

/** Cuts text to at most maxChars, at a word boundary, marking the cut with an ellipsis. */
export function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars - 1);
  const space = cut.lastIndexOf(" ");
  const head = space > maxChars / 2 ? cut.slice(0, space) : cut;
  return `${head.replace(/[\s,;:.–—-]+$/, "")}…`;
}

/** "Thursday, September 24, 2026", built from the date parts so it can't drift a day. */
export function formatEditionDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map((n) => parseInt(n, 10));
  if (y === undefined || m === undefined || d === undefined || Number.isNaN(y)) return isoDate;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}
