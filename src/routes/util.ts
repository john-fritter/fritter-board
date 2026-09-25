import type { Context } from "hono";
import type { JSX } from "hono/jsx/jsx-runtime";
import { setCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { config, type Env } from "../config.js";
import { ForumError } from "../forum/errors.js";

export const SESSION_COOKIE = "fb_session";
export const THEME_COOKIE = "fb_theme";

export async function render(c: Context, node: JSX.Element, status: ContentfulStatusCode = 200) {
  return c.html(`<!DOCTYPE html>${await node.toString()}`, status);
}

/** Reads a urlencoded form into plain string fields; files and missing fields read as "". */
export async function readForm(c: Context): Promise<(name: string) => string> {
  const body = await c.req.parseBody();
  return (name) => {
    const v = body[name];
    return typeof v === "string" ? v : "";
  };
}

/** Parses a path id. Anything else is a 404, not a 500. */
export function parseId(raw: string | undefined): number {
  if (!raw || !/^\d{1,15}$/.test(raw)) throw new ForumError(404, "That page doesn't exist.");
  return Number(raw);
}

/**
 * Only same-site paths are accepted as a place to return to, so a crafted
 * ?next= can't bounce a member off to another site after logging in.
 */
export function safeNext(raw: string | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}

export function setSessionCookie(c: Context, env: Env, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    path: env.basePath || "/",
    httpOnly: true,
    secure: env.secureCookies,
    sameSite: "Lax",
    maxAge: Math.floor(config.sessions.lifetime_days * 24 * 60 * 60),
  });
}

/** Form errors are shown on the form; anything else propagates to the error page. */
export function formError(err: unknown): { message: string; status: ContentfulStatusCode } {
  if (err instanceof ForumError && err.status !== 404) return { message: err.message, status: err.status };
  throw err;
}
