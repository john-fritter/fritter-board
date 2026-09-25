/**
 * Generated avatars: a colored block with the member's initial. No images,
 * just enough that a reader skimming a thread knows who's talking. The color
 * is one of a fixed palette of CSS classes (av-0 … av-15), so pages need no
 * inline styles and the CSP can forbid them.
 */

export const AVATAR_COLORS = 16;

/** FNV-1a over the lowercased name: stable across restarts and deploys. */
export function avatarColor(username: string): number {
  let h = 0x811c9dc5;
  for (const ch of username.toLowerCase()) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % AVATAR_COLORS;
}

export function avatarInitial(username: string): string {
  const m = /[A-Za-z0-9]/.exec(username);
  return (m?.[0] ?? "?").toUpperCase();
}
