import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

/**
 * What the voice test and dry visits measure in a post, the same way the
 * voice metrics do (src/metrics/voice.ts, which the runner can't import):
 * its own words with quotes removed, whether it opens with a quote, asks a
 * question, uses a house phrase, or quotes someone and praises the line.
 * The phrase lists are config/voice-metrics.yaml's.
 */

export interface Pattern {
  name: string;
  pattern: RegExp;
}

const FILE = path.join(import.meta.dirname, "..", "..", "config", "voice-metrics.yaml");
const ListSchema = z.array(z.object({ name: z.string().min(1), pattern: z.string().min(1) }));
const FileSchema = z.object({ phrases: ListSchema.min(1), praise: ListSchema.min(1) });

export function loadPatterns(file = FILE): { phrases: Pattern[]; praise: Pattern[] } {
  const raw = FileSchema.parse(YAML.parse(readFileSync(file, "utf-8")));
  const compile = (list: z.infer<typeof ListSchema>, flags: string) => list.map((p) => ({ name: p.name, pattern: new RegExp(p.pattern, flags) }));
  return { phrases: compile(raw.phrases, "i"), praise: compile(raw.praise, "im") };
}

/** A post without its quotes, innermost first, as the board's stripQuotes does it. */
export function stripQuotes(body: string): string {
  let stripped = body.replace(/\r\n?/g, "\n");
  const innermost = /\[quote(?:=[^\]\n]*)?\](?:(?!\[quote)[\s\S])*?\[\/quote\]\n?/gi;
  let prev: string;
  do {
    prev = stripped;
    stripped = stripped.replace(innermost, "");
  } while (stripped !== prev);
  return stripped;
}

/** A post's own words: quotes removed, formatting tags dropped, apostrophes straightened. */
export function ownText(body: string): string {
  return stripQuotes(body)
    .replace(/\[\/?(?:b|i|u|s|code|list|\*)\]/gi, "")
    .replace(/[‘’]/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

export interface PostMeasure {
  words: number;
  opensWithQuote: boolean;
  quotes: boolean;
  question: boolean;
  phrases: string[];
  /** Praise patterns found in a post that quotes; empty when it doesn't quote. */
  praise: string[];
}

export function measurePost(body: string, patterns: { phrases: Pattern[]; praise: Pattern[] }): PostMeasure {
  const own = ownText(body);
  const quotes = /\[quote\b/i.test(body);
  return {
    words: wordCount(own),
    opensWithQuote: /^\s*\[quote\b/i.test(body),
    quotes,
    question: own.includes("?"),
    phrases: patterns.phrases.filter((p) => p.pattern.test(own)).map((p) => p.name),
    praise: quotes ? patterns.praise.filter((p) => p.pattern.test(own)).map((p) => p.name) : [],
  };
}

/** Whether a post's length is within the tolerance of what it was asked for. */
export function onLength(words: number, asked: number, tolerance: number): boolean {
  return Math.abs(words - asked) <= asked * tolerance;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}
