/**
 * A persona's parts. The text an admin edits is one document; two headings
 * in it, on lines of their own, mark the parts the runner treats apart:
 *
 *   (the core: who the character is and how it writes)
 *   ## Stance
 *   (what it does with other people's posts)
 *   ## Sides
 *   ### Catching up (weight 4, 15-50 words)
 *   (how the character is on a visit with this side)
 *   ### …
 *
 * The core and the stance go in every visit's system prompt, so it stays the
 * same from visit to visit and caches. Sides never do: a visit picks one, and
 * its paragraph and a length rolled from its range open the visit's first
 * message. A persona without the headings is all core, as before sides.
 */

export interface Side {
  name: string;
  weight: number;
  minWords: number;
  maxWords: number;
  text: string;
}

export interface PersonaParts {
  core: string;
  stance: string | null;
  sides: Side[];
}

const STANCE = /^##\s+stance\s*$/i;
const SIDES = /^##\s+sides\s*$/i;
const SIDE = /^###\s+(.+?)\s*\(\s*weight\s+(\d+(?:\.\d+)?)\s*,\s*(\d+)\s*(?:-|–|—|to)\s*(\d+)\s*words?\s*\)\s*$/i;

/**
 * The parts of a persona, and what's wrong with its format. A side whose
 * heading doesn't parse is left out, and named among the problems.
 */
export function parsePersona(text: string): PersonaParts & { problems: string[] } {
  const problems: string[] = [];
  const sections: Record<"core" | "stance" | "sides", string[]> = { core: [], stance: [], sides: [] };
  const seen = new Set<string>();
  let current: keyof typeof sections = "core";
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const heading = STANCE.test(line) ? "stance" : SIDES.test(line) ? "sides" : null;
    if (heading) {
      if (seen.has(heading)) problems.push(`There are two "## ${heading === "stance" ? "Stance" : "Sides"}" headings.`);
      seen.add(heading);
      current = heading;
      continue;
    }
    sections[current].push(line);
  }

  const sides: Side[] = [];
  let side: Side | null = null;
  // Under a heading that didn't parse: its text goes with it, unreported.
  let skipping = false;
  const finish = () => {
    if (!side) return;
    side.text = side.text.trim();
    if (!side.text) problems.push(`The side "${side.name}" has no text.`);
    else sides.push(side);
    side = null;
  };
  for (const line of sections.sides) {
    if (/^###\s/.test(line)) {
      finish();
      skipping = true;
      const m = SIDE.exec(line);
      if (!m) {
        problems.push(`"${line.trim()}" should read like "### Catching up (weight 4, 15-50 words)".`);
        continue;
      }
      const [, name, weight, min, max] = m;
      const s: Side = { name: name!, weight: Number(weight), minWords: Number(min), maxWords: Number(max), text: "" };
      if (s.weight <= 0) problems.push(`The side "${s.name}" needs a weight above 0.`);
      else if (s.minWords < 1 || s.minWords > s.maxWords) problems.push(`The side "${s.name}" needs a range like 15-50 words.`);
      else if (sides.some((o) => o.name.toLowerCase() === s.name.toLowerCase())) problems.push(`There are two sides called "${s.name}".`);
      else {
        side = s;
        skipping = false;
      }
      continue;
    }
    if (side) side.text += `${line}\n`;
    else if (line.trim() && !skipping) problems.push(`"${line.trim().slice(0, 40)}" under "## Sides" isn't under a side's heading.`);
  }
  finish();
  if (seen.has("sides") && sides.length === 0 && problems.length === 0) problems.push(`"## Sides" has no sides under it.`);

  const stance = sections.stance.join("\n").trim();
  return { core: sections.core.join("\n").trim(), stance: stance || null, sides, problems };
}

/** What a persona puts in the system prompt: its core and its stance, never its sides. */
export function personaPrompt(text: string): string {
  const p = parsePersona(text);
  return [p.core, p.stance].filter(Boolean).join("\n\n");
}

/** A side by weight. `random` is in [0, 1). */
export function pickSide(sides: Side[], random: () => number): Side | null {
  const total = sides.reduce((n, s) => n + s.weight, 0);
  if (total <= 0) return null;
  let r = random() * total;
  for (const s of sides) {
    r -= s.weight;
    if (r < 0) return s;
  }
  return sides[sides.length - 1]!;
}

/** A length in the side's range, rounded to 5 words where the range allows it. */
export function rollWords(side: Pick<Side, "minWords" | "maxWords">, random: () => number): number {
  const raw = side.minWords + random() * (side.maxWords - side.minWords);
  const rounded = Math.round(raw / 5) * 5;
  if (rounded >= side.minWords && rounded <= side.maxWords) return Math.max(1, rounded);
  return Math.round(raw);
}

/**
 * The lines that open a visit with a side: the side's paragraph, the length,
 * and the way out. A side that assumes something happened ("you remember an
 * old thread", "you changed your mind") made models invent it in the first
 * voice test, so every side is offered as a leaning, never a script.
 */
export function sideText(side: Side, words: number): string {
  return `This visit: ${side.text}\n\nKeep each post or message this visit to about ${words} words, not counting what you quote.\n\n${SIDE_WAY_OUT}`;
}

export const SIDE_WAY_OUT =
  "That's what you're inclined to do, not a script. If nothing on the board fits it, do what you'd usually do instead. Never make up a post, a conversation or something you did to fit it.";

export interface Voice {
  side: Side;
  words: number;
}
