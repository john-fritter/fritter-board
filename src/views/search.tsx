import { raw } from "hono/html";
import type { SearchHit } from "../forum/search.js";
import type { Page } from "../lib/pagination.js";
import { Crumbs, ErrorNote, Pagination, Time, UserLink } from "./components.js";
import type { PageCtx } from "./context.js";
import { Layout } from "./layout.js";

export function SearchPage(props: {
  ctx: PageCtx;
  q: string;
  author: string;
  board: string;
  sort: "newest" | "relevance";
  boards: { slug: string; name: string }[];
  hits: SearchHit[];
  total: number;
  page: Page;
  searched: boolean;
  error: string | null;
}) {
  const { ctx } = props;
  const params = new URLSearchParams();
  if (props.q) params.set("q", props.q);
  if (props.author) params.set("author", props.author);
  if (props.board) params.set("board", props.board);
  if (props.sort !== "newest") params.set("sort", props.sort);
  // Pagination appends ?page=; fold the search terms into its base.
  const base = `/search?${params.toString()}`;
  return (
    <Layout ctx={ctx} title={props.q ? `Search: ${props.q}` : "Search"}>
      <Crumbs ctx={ctx} trail={[{ label: "Search" }]} />
      <form method="get" action={ctx.url("/search")} class="inline-fields search-form">
        <label class="grow">
          Words
          <input type="text" name="q" value={props.q} placeholder={`zoning "city council" -parking`} />
        </label>
        <label>
          By
          <input type="text" name="author" value={props.author} placeholder="any member" />
        </label>
        <label>
          In
          <select name="board">
            <option value="">All boards</option>
            {props.boards.map((b) => (
              <option value={b.slug} selected={b.slug === props.board}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Sort
          <select name="sort">
            <option value="newest" selected={props.sort === "newest"}>
              Newest
            </option>
            <option value="relevance" selected={props.sort === "relevance"}>
              Best match
            </option>
          </select>
        </label>
        <button type="submit">Search</button>
      </form>
      <ErrorNote message={props.error} />
      {props.searched && (
        <>
          <div class="toolbar">
            <span class="meta">
              {props.total.toLocaleString("en-US")} {props.total === 1 ? "post" : "posts"} found
            </span>
            <Pagination ctx={ctx} base={base} page={props.page} />
          </div>
          <ol class="search-results">
            {props.hits.map((h) => (
              <li>
                <a class="thread-title" href={ctx.url(`/p/${h.postId}`)}>
                  {h.threadTitle}
                </a>
                <div class="meta">
                  <UserLink ctx={ctx} username={h.authorName} /> in {h.boardName}, <Time d={h.createdAt} />
                </div>
                <p class="snippet">{raw(h.snippetHtml)}</p>
              </li>
            ))}
          </ol>
        </>
      )}
    </Layout>
  );
}
