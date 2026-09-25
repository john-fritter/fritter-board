import assert from "node:assert/strict";
import { LoginLimiter } from "../src/auth/login-limiter.js";
import { createApp } from "../src/app.js";
import { parsePublicUrl } from "../src/config.js";
import { insertUser } from "../src/forum/accounts.js";
import { reply } from "../src/forum/threads.js";
import { ORIGIN, run, setup, threadIdFrom } from "./support.js";

// Phase 1 end to end: visibility, invites, posting, quoting, locks,
// pagination, settings, CSRF, the login limiter, and sub-path deployment.

const { pool, app, forum, reset, req, login } = setup("app");

async function main() {
  await reset();

  await insertUser(pool, { username: "John", password: "admin-password-1", role: "admin" });

  // ── Anonymous visitors see public boards only ──
  let res = await req("GET", "/");
  assert.equal(res.status, 200);
  assert.ok(res.text.startsWith("<!DOCTYPE html>"));
  assert.ok(res.text.includes("General"));
  assert.ok(!res.text.includes("Back Room"), "the private board is hidden from the public");
  assert.equal((await req("GET", "/b/back-room")).status, 404);
  assert.equal((await req("GET", "/b/general")).status, 200);
  assert.equal((await req("GET", "/admin")).status, 404);

  // ── Admin logs in and makes an invite ──
  const admin = await login("john", "admin-password-1"); // usernames are case-insensitive
  res = await req("GET", "/", { cookie: admin });
  assert.ok(res.text.includes("Back Room"));
  res = await req("POST", "/admin/invites", { cookie: admin, form: { note: "Dan", expiry: "14" } });
  assert.equal(res.status, 303);
  const code = new URL(res.location!, ORIGIN).searchParams.get("new")!;
  assert.ok(code.length >= 16);
  res = await req("GET", `/admin?new=${code}`, { cookie: admin });
  assert.ok(res.text.includes(`/register?code=${code}`));

  // ── Registration spends the invite exactly once ──
  res = await req("POST", "/register", { form: { code: "nope", username: "Dan", password: "dan-password-1", password2: "dan-password-1" } });
  assert.equal(res.status, 400);
  res = await req("POST", "/register", { form: { code, username: "john", password: "dan-password-1", password2: "dan-password-1" } });
  assert.equal(res.status, 409, "username collision is case-insensitive");
  res = await req("POST", "/register", { form: { code, username: "Dan", password: "dan-password-1", password2: "dan-password-1" } });
  assert.equal(res.status, 303);
  const dan = res.cookie!;
  res = await req("POST", "/register", { form: { code, username: "Eve", password: "eve-password-1", password2: "eve-password-1" } });
  assert.equal(res.status, 400, "an invite is single-use");

  // ── Posting ──
  res = await req("POST", "/b/general/new", {
    cookie: dan,
    form: { title: "First <thread>", body: "Hello [b]board[/b] <script>x</script>", action: "post" },
  });
  assert.equal(res.status, 303);
  const t1 = threadIdFrom(res.location);
  res = await req("GET", `/t/${t1}`);
  assert.equal(res.status, 200);
  assert.ok(res.text.includes("First &lt;thread&gt;"));
  assert.ok(res.text.includes("Hello <strong>board</strong> &lt;script&gt;x&lt;/script&gt;"));
  assert.ok(!res.text.includes("<script>"));
  assert.ok(res.text.includes("Log in</a> to reply"));

  // Preview renders without posting.
  res = await req("POST", `/t/${t1}/reply`, { cookie: admin, form: { body: "[i]draft[/i]", action: "preview" } });
  assert.equal(res.status, 200);
  assert.ok(res.text.includes("<em>draft</em>"));
  assert.equal((await pool.query("SELECT reply_count FROM threads WHERE id = $1", [t1])).rows[0].reply_count, 0);

  // Quote pre-fills an attributed quote, and the reply lands on its post.
  const { rows: firstPost } = await pool.query("SELECT first_post_id FROM threads WHERE id = $1", [t1]);
  const p1 = firstPost[0].first_post_id as number;
  res = await req("GET", `/t/${t1}/reply?quote=${p1}`, { cookie: admin });
  assert.ok(res.text.includes(`[quote=&quot;Dan&quot; post=${p1}]`));
  res = await req("POST", `/t/${t1}/reply`, {
    cookie: admin,
    form: { body: `[quote="Dan" post=${p1}]Hello[/quote]\nWelcome.`, action: "post" },
  });
  assert.equal(res.status, 303);
  assert.match(res.location!, /\/p\/\d+$/);
  res = await req("GET", res.location!.replace(ORIGIN, ""));
  assert.equal(res.status, 302);
  assert.match(res.location!, new RegExp(`/t/${t1}#p\\d+$`));
  res = await req("GET", `/t/${t1}`);
  assert.ok(res.text.includes(`<a href="/p/${p1}">Dan wrote:</a>`));

  // Counts are denormalized in the same transaction as the post.
  const counts = await pool.query(
    `SELECT (SELECT post_count FROM users WHERE username = 'Dan') AS dan,
            (SELECT post_count FROM users WHERE username = 'John') AS john,
            (SELECT thread_count FROM boards WHERE slug = 'general') AS threads,
            (SELECT post_count FROM boards WHERE slug = 'general') AS posts,
            (SELECT reply_count FROM threads WHERE id = ${t1}) AS replies`
  );
  assert.deepEqual(counts.rows[0], { dan: 1, john: 1, threads: 1, posts: 2, replies: 1 });

  // Empty posts and anonymous posts are refused.
  res = await req("POST", `/t/${t1}/reply`, { cookie: dan, form: { body: "   ", action: "post" } });
  assert.equal(res.status, 400);
  res = await req("POST", `/t/${t1}/reply`, { form: { body: "hi", action: "post" } });
  assert.equal(res.status, 403);
  res = await req("GET", "/b/general/new");
  assert.equal(res.status, 303);
  assert.ok(res.location!.includes("/login?next="));

  // ── Cross-site form posts are rejected ──
  res = await req("POST", `/t/${t1}/reply`, { cookie: dan, origin: "https://evil.example", form: { body: "x", action: "post" } });
  assert.equal(res.status, 403);
  res = await req("POST", `/t/${t1}/reply`, { cookie: dan, origin: null, form: { body: "x", action: "post" } });
  assert.equal(res.status, 403);

  // ── The private board stays private everywhere ──
  res = await req("POST", "/b/back-room/new", { cookie: dan, form: { title: "Secret", body: "members only text", action: "post" } });
  const secret = threadIdFrom(res.location);
  assert.equal((await req("GET", `/t/${secret}`)).status, 404);
  const { rows: secretPost } = await pool.query("SELECT first_post_id FROM threads WHERE id = $1", [secret]);
  assert.equal((await req("GET", `/p/${secretPost[0].first_post_id}`)).status, 404);
  res = await req("GET", "/u/Dan");
  assert.equal(res.status, 200);
  assert.ok(!res.text.includes("members only text"), "anonymous profile views omit private posts");
  assert.ok(res.text.includes("Hello <strong>board</strong>"));
  res = await req("GET", "/u/dan", { cookie: admin });
  assert.ok(res.text.includes("members only text"));
  res = await req("GET", "/", { cookie: dan });
  assert.ok(res.text.includes("Secret"));

  // ── Locked threads take replies from moderators only ──
  await pool.query("UPDATE threads SET locked = TRUE WHERE id = $1", [t1]);
  res = await req("POST", `/t/${t1}/reply`, { cookie: dan, form: { body: "let me in", action: "post" } });
  assert.equal(res.status, 403);
  res = await req("POST", `/t/${t1}/reply`, { cookie: admin, form: { body: "mods may", action: "post" } });
  assert.equal(res.status, 303);
  await pool.query("UPDATE threads SET locked = FALSE WHERE id = $1", [t1]);

  // ── Pagination and permalinks ──
  const { rows: danRow } = await pool.query("SELECT id FROM users WHERE username = 'Dan'");
  const danViewer = { id: danRow[0].id as number, username: "Dan", role: "member" as const, status: "active" as const, isBot: false };
  let lastPost = 0;
  for (let i = 0; i < 30; i++) lastPost = (await reply(forum, danViewer, t1, `reply ${i}`)).postId;
  res = await req("GET", `/p/${lastPost}`);
  assert.match(res.location!, new RegExp(`/t/${t1}\\?page=2#p${lastPost}$`));
  res = await req("GET", `/t/${t1}?page=2`);
  assert.ok(res.text.includes(`id="p${lastPost}"`));
  assert.ok(res.text.includes("Page 2 of 2"));
  res = await req("GET", `/t/${t1}?page=99`);
  assert.ok(res.text.includes("Page 2 of 2"), "out-of-range pages clamp");
  assert.equal((await req("GET", "/t/abc")).status, 404);
  assert.equal((await req("GET", "/t/999999")).status, 404);

  // ── Profile settings ──
  res = await req("POST", "/settings/profile", { cookie: dan, form: { title: "Zoning Enjoyer", bio: "I read [i]everything[/i]." } });
  assert.equal(res.status, 303);
  res = await req("GET", `/t/${t1}`);
  assert.ok(res.text.includes("Zoning Enjoyer"));
  res = await req("GET", "/u/Dan");
  assert.ok(res.text.includes("I read <em>everything</em>."));
  res = await req("GET", "/members");
  assert.ok(res.text.includes("Dan") && res.text.includes("John"));

  // Rank titles fill in when no custom title is set (John has 2 posts).
  res = await req("GET", "/u/John");
  assert.ok(res.text.includes("Newcomer"));

  // ── Members can't reach admin ──
  assert.equal((await req("GET", "/admin", { cookie: dan })).status, 404);
  assert.equal((await req("POST", "/admin/invites", { cookie: dan, form: { note: "x", expiry: "1" } })).status, 404);

  // ── Password change ends other sessions ──
  const dan2 = await login("Dan", "dan-password-1");
  res = await req("POST", "/settings/password", {
    cookie: dan,
    form: { current: "dan-password-1", password: "dan-password-2", password2: "dan-password-2" },
  });
  assert.equal(res.status, 303);
  res = await req("GET", "/settings", { cookie: dan2 });
  assert.equal(res.status, 303, "the other session was logged out");
  res = await req("GET", "/settings", { cookie: dan });
  assert.equal(res.status, 200, "the session that changed it survives");

  // ── Logout ──
  res = await req("POST", "/logout", { cookie: dan });
  assert.equal(res.status, 303);
  res = await req("GET", "/settings", { cookie: dan });
  assert.equal(res.status, 303);

  // ── Failed logins lock out a username for the window ──
  for (let i = 0; i < 3; i++) {
    res = await req("POST", "/login", { form: { username: "Dan", password: "wrong", next: "/" } });
    assert.equal(res.status, 400);
  }
  res = await req("POST", "/login", { form: { username: "dan", password: "dan-password-2", next: "/" } });
  assert.equal(res.status, 429);

  // ── Open redirects are refused ──
  res = await req("POST", "/login", { form: { username: "John", password: "admin-password-1", next: "//evil.example/" } });
  assert.equal(res.location, "/");

  // ── Theme ──
  res = await req("POST", "/theme", { form: { theme: "dark", next: "/b/general" } });
  assert.equal(res.location, "/b/general");
  res = await req("GET", "/", { cookie: res.cookie });
  assert.ok(res.text.includes(`data-theme="dark"`));

  // ── A sub-path deployment prefixes every link ──
  const sub = createApp({ pool, env: parsePublicUrl(`${ORIGIN}/board`, 0), limiter: new LoginLimiter(3, 60_000) });
  res = await req("GET", "/board/", { appOverride: sub });
  assert.equal(res.status, 200);
  assert.ok(res.text.includes(`href="/board/b/general"`));
  assert.ok(res.text.includes(`href="/board/static/style.css?v=`));
  res = await req("GET", `/board/p/${lastPost}`, { appOverride: sub });
  assert.ok(res.location!.startsWith(`/board/t/${t1}`));
  res = await req("GET", "/board/static/style.css", { appOverride: sub });
  assert.equal(res.status, 200);

  // ── Security headers ──
  const raw = await app.request(`${ORIGIN}/`);
  assert.ok(raw.headers.get("content-security-policy")?.includes("default-src 'none'"));

}

run("app", pool, main);
