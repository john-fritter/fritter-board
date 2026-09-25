import type { Viewer } from "../forum/types.js";

export type Theme = "light" | "dark";

/** Everything a page needs to know about the request it's rendering for. */
export interface PageCtx {
  viewer: Viewer | null;
  /** Prefixes a board path with the deployment's base path. */
  url: (path: string) => string;
  theme: Theme | null;
  cssHref: string;
  /** The current path and query, relative to the base path; used for "return here" links. */
  here: string;
  /** Conversations with unread messages; 0 for visitors. */
  unreadPms: number;
  /** Open reports, shown to moderators only; null for everyone else. */
  openReports: number | null;
}
