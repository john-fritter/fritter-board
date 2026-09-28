import { readFileSync } from "node:fs";
import path from "node:path";
import type { Db } from "./store.js";

/**
 * The role briefs a bot's prompt is built from, between the board's own
 * instructions and the bot's persona:
 *
 * - `member`: what the board is and how to be a member of it. Every bot.
 * - `moderator_member`: added on the ordinary visits of a bot that moderates.
 * - `moderation`: the moderator's brief, for moderation cycles.
 *
 * The admin edits them at /admin/bots/briefs (or `npm run bot -- brief`);
 * every version is kept in bots.brief_versions, and the newest is current.
 * Until one is written, the text shipped in config/briefs/<name>.md is.
 */

export const BRIEF_NAMES = ["member", "moderator_member", "moderation"] as const;
export type BriefName = (typeof BRIEF_NAMES)[number];

export const BRIEF_TITLES: Record<BriefName, string> = {
  member: "Every member",
  moderator_member: "A member who moderates, on ordinary visits",
  moderation: "Moderation cycles",
};

export type Briefs = Record<BriefName, string>;

const BRIEFS_DIR = path.join(import.meta.dirname, "..", "..", "config", "briefs");

let defaults: Briefs | null = null;

/** The briefs shipped with the board, read once. */
export function defaultBriefs(): Briefs {
  defaults ??= Object.fromEntries(
    BRIEF_NAMES.map((name) => [name, readFileSync(path.join(BRIEFS_DIR, `${name}.md`), "utf-8").trim()])
  ) as Briefs;
  return defaults;
}

export function isBriefName(s: string): s is BriefName {
  return (BRIEF_NAMES as readonly string[]).includes(s);
}

export interface BriefVersion {
  id: number;
  name: BriefName;
  body: string;
  createdBy: string;
  createdAt: Date;
}

/** The current briefs: the newest version of each, or the shipped text. */
export async function currentBriefs(db: Db): Promise<Briefs> {
  const { rows } = await db.query<{ name: BriefName; body: string }>(
    "SELECT DISTINCT ON (name) name, body FROM bots.brief_versions ORDER BY name, id DESC"
  );
  const out = { ...defaultBriefs() };
  for (const r of rows) out[r.name] = r.body;
  return out;
}

/** A brief's saved versions, newest first. */
export async function briefVersions(db: Db, name: BriefName, limit: number): Promise<BriefVersion[]> {
  const { rows } = await db.query<{ id: number; name: BriefName; body: string; created_by: string; created_at: Date }>(
    "SELECT id, name, body, created_by, created_at FROM bots.brief_versions WHERE name = $1 ORDER BY id DESC LIMIT $2",
    [name, limit]
  );
  return rows.map((r) => ({ id: r.id, name: r.name, body: r.body, createdBy: r.created_by, createdAt: r.created_at }));
}
