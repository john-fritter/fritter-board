import assert from "node:assert/strict";
import "../src/dotenv.js";
import { LoginLimiter } from "../src/auth/login-limiter.js";
import { createApp } from "../src/app.js";
import { parsePublicUrl } from "../src/config.js";
import { createPool } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { renderBBCode } from "../src/markup/bbcode.js";

// Shared setup for the integration suites: the real app over a real Postgres.
// Each suite drops and recreates the board schema in TEST_DATABASE_URL, so
// this refuses to touch DATABASE_URL.

export function testDatabaseUrl(suite: string): string {
  const url = process.env["TEST_DATABASE_URL"];
  if (!url) {
    console.log(`${suite}: skipped (TEST_DATABASE_URL not set)`);
    process.exit(0);
  }
  if (url === process.env["DATABASE_URL"]) {
    console.error("TEST_DATABASE_URL must not be the same as DATABASE_URL.");
    process.exit(1);
  }
  return url;
}

export const ORIGIN = "http://board.test";

export interface Res {
  status: number;
  location: string | null;
  cookie: string | null;
  text: string;
}

export function setup(suite: string) {
  const pool = createPool(testDatabaseUrl(suite));
  const limiter = new LoginLimiter(3, 60_000);
  const app = createApp({ pool, env: parsePublicUrl(ORIGIN, 0), limiter });
  const forum = { pool, renderMarkup: (b: string) => renderBBCode(b, { postUrl: (id) => `/p/${id}` }) };

  async function reset(): Promise<void> {
    await pool.query("DROP SCHEMA IF EXISTS board CASCADE");
    await migrate(pool, () => {});
  }

  async function req(
    method: "GET" | "POST",
    path: string,
    opts: { form?: Record<string, string>; cookie?: string | null; origin?: string | null; appOverride?: typeof app } = {}
  ): Promise<Res> {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers["Cookie"] = opts.cookie;
    if (method === "POST") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      if (opts.origin !== null) headers["Origin"] = opts.origin ?? ORIGIN;
    }
    const res = await (opts.appOverride ?? app).request(`${ORIGIN}${path}`, {
      method,
      headers,
      body: opts.form ? new URLSearchParams(opts.form).toString() : undefined,
    });
    const setCookie = res.headers.get("set-cookie");
    return {
      status: res.status,
      location: res.headers.get("location"),
      cookie: setCookie ? setCookie.split(";")[0]! : null,
      text: await res.text(),
    };
  }

  async function login(username: string, password: string): Promise<string> {
    const res = await req("POST", "/login", { form: { username, password, next: "/" } });
    assert.equal(res.status, 303, `login as ${username}: ${res.text.slice(0, 200)}`);
    assert.ok(res.cookie?.startsWith("fb_session="));
    return res.cookie!;
  }

  return { pool, app, forum, limiter, reset, req, login };
}

export function threadIdFrom(location: string | null): number {
  const m = /\/t\/(\d+)/.exec(location ?? "");
  assert.ok(m, `expected a thread redirect, got ${location}`);
  return Number(m[1]);
}

/** Runs a suite and always closes the pool. */
export function run(suite: string, pool: { end(): Promise<void> }, main: () => Promise<void>): void {
  main()
    .then(() => console.log(`${suite}: all tests passed`))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
