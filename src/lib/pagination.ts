export interface Page {
  /** 1-based current page, clamped to what exists. */
  page: number;
  pageCount: number;
  offset: number;
  perPage: number;
}

/** Parses a ?page= value and clamps it to the pages that exist (always at least one). */
export function paginate(rawPage: string | number | undefined, total: number, perPage: number): Page {
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const parsed = typeof rawPage === "number" ? rawPage : Number.parseInt(rawPage ?? "1", 10);
  const page = Number.isFinite(parsed) ? Math.min(Math.max(1, parsed), pageCount) : 1;
  return { page, pageCount, offset: (page - 1) * perPage, perPage };
}

/** The page a 1-based position lands on. */
export function pageOf(position: number, perPage: number): number {
  return Math.max(1, Math.ceil(position / perPage));
}
