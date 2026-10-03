import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { config, type Env } from "../config.js";

/**
 * The multi-quote selection: post ids ticked across a thread's pages, kept in
 * a cookie so it works with plain forms. One thread at a time; ticking a post
 * in another thread starts over. The ids are only a wish list: every use goes
 * through quotablePosts, which drops anything the reply may not quote.
 */
export const MULTIQUOTE_COOKIE = "fb_mq";

const VALUE_RE = /^(\d{1,15}):(\d{1,15}(?:\.\d{1,15})*)$/;

/** The ids selected in this thread, oldest selection first; [] if the selection is for another thread. */
export function readSelection(c: Context, threadId: number): number[] {
  const m = VALUE_RE.exec(getCookie(c, MULTIQUOTE_COOKIE) ?? "");
  if (!m || Number(m[1]) !== threadId) return [];
  return m[2]!.split(".").map(Number).slice(0, config.limits.multiquote_max);
}

export function saveSelection(c: Context, env: Env, threadId: number, ids: readonly number[]): void {
  if (ids.length === 0) return clearSelection(c, env);
  setCookie(c, MULTIQUOTE_COOKIE, `${threadId}:${ids.join(".")}`, {
    path: env.basePath || "/",
    httpOnly: true,
    secure: env.secureCookies,
    sameSite: "Lax",
    maxAge: Math.floor(config.limits.multiquote_hours * 60 * 60),
  });
}

export function clearSelection(c: Context, env: Env): void {
  deleteCookie(c, MULTIQUOTE_COOKIE, { path: env.basePath || "/" });
}
