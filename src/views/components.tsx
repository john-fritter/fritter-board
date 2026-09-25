import type { Child } from "hono/jsx";
import { avatarColor, avatarInitial } from "../lib/avatar.js";
import type { Page } from "../lib/pagination.js";
import { formatDateTime, iso } from "../lib/time.js";
import type { PageCtx } from "./context.js";

export function Avatar(props: { username: string; size?: "small" | "large" }) {
  const size = props.size ?? "large";
  return (
    <span class={`avatar avatar-${size} av-${avatarColor(props.username)}`} aria-hidden="true">
      {avatarInitial(props.username)}
    </span>
  );
}

export function userPath(username: string): string {
  return `/u/${encodeURIComponent(username)}`;
}

export function UserLink(props: { ctx: PageCtx; username: string }) {
  return (
    <a class="user-link" href={props.ctx.url(userPath(props.username))}>
      {props.username}
    </a>
  );
}

export function BotBadge() {
  return (
    <span class="badge badge-bot" title="This member is a bot.">
      BOT
    </span>
  );
}

export function Time(props: { d: Date }) {
  return <time datetime={iso(props.d)}>{formatDateTime(props.d)}</time>;
}

export function Crumbs(props: { ctx: PageCtx; trail: { label: string; href?: string }[] }) {
  return (
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href={props.ctx.url("/")}>Index</a>
      {props.trail.map((c) => (
        <>
          <span class="sep"> › </span>
          {c.href ? <a href={props.ctx.url(c.href)}>{c.label}</a> : <span>{c.label}</span>}
        </>
      ))}
    </nav>
  );
}

/** Page numbers with the first, last and a window around the current page. */
export function pageWindow(page: number, pageCount: number, radius = 2): (number | null)[] {
  const out: (number | null)[] = [];
  for (let p = 1; p <= pageCount; p++) {
    if (p === 1 || p === pageCount || Math.abs(p - page) <= radius) out.push(p);
    else if (out[out.length - 1] !== null) out.push(null);
  }
  return out;
}

export function Pagination(props: { ctx: PageCtx; base: string; page: Page }) {
  const { page, pageCount } = props.page;
  if (pageCount <= 1) return null;
  const sep = props.base.includes("?") ? "&" : "?";
  const href = (p: number) => props.ctx.url(p === 1 ? props.base : `${props.base}${sep}page=${p}`);
  return (
    <nav class="pagination" aria-label="Pages">
      <span class="page-label">
        Page {page} of {pageCount}
      </span>
      {page > 1 && (
        <a href={href(page - 1)} rel="prev">
          ‹ Prev
        </a>
      )}
      {pageWindow(page, pageCount).map((p) =>
        p === null ? (
          <span class="gap">…</span>
        ) : p === page ? (
          <strong aria-current="page">{p}</strong>
        ) : (
          <a href={href(p)}>{p}</a>
        )
      )}
      {page < pageCount && (
        <a href={href(page + 1)} rel="next">
          Next ›
        </a>
      )}
    </nav>
  );
}

export function ErrorNote(props: { message: string | null | undefined }) {
  if (!props.message) return null;
  return (
    <p class="notice notice-error" role="alert">
      {props.message}
    </p>
  );
}

export function Panel(props: { title: Child; children?: Child }) {
  return (
    <section class="panel">
      <h2 class="panel-head">{props.title}</h2>
      <div class="panel-body">{props.children}</div>
    </section>
  );
}
