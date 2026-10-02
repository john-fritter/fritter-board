import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { insertUser } from "../src/forum/accounts.js";
import { ORIGIN, run, setup, threadIdFrom } from "./support.js";

// The reply box: multi-quote across a thread's pages, and the optional
// formatting script with the CSP that allows it and nothing else.

const { pool, app, reset, req, login } = setup("editor");

const PER_PAGE = config.pagination.posts_per_page;
/** What the reply form's text box holds. */
const draft = (html: string) => /<textarea name="body"[^>]*>([\s\S]*?)<\/textarea>/.exec(html)?.[1] ?? "";
const MAX = config.limits.multiquote_max;

async function main() {
  await reset();
  await insertUser(pool, { username: "John", password: "admin-password-1", role: "admin" });
  await insertUser(pool, { username: "Dan", password: "dan-password-1" });
  await insertUser(pool, { username: "Amy", password: "amy-password-1" });
  const admin = await login("John", "admin-password-1");
  const dan = await login("Dan", "dan-password-1");
  const amy = await login("Amy", "amy-password-1");

  // A thread two pages long, Dan and Amy taking turns.
  let res = await req("POST", "/b/general/new", { cookie: dan, form: { title: "Long one", body: "post 1 by Dan", action: "post" } });
  const t = threadIdFrom(res.location);
  for (let i = 2; i <= PER_PAGE + 5; i++) {
    const who = i % 2 === 0 ? amy : dan;
    res = await req("POST", `/t/${t}/reply`, { cookie: who, form: { body: `post ${i} by ${i % 2 === 0 ? "Amy" : "Dan"}`, action: "post" } });
    assert.equal(res.status, 303);
  }
  const { rows } = await pool.query<{ id: number }>("SELECT id FROM posts WHERE thread_id = $1 ORDER BY id", [t]);
  const post = (n: number) => rows[n - 1]!.id;
  const late = PER_PAGE + 3; // on page 2

  // ── The toggles are for members who can reply ──
  res = await req("GET", `/t/${t}`);
  assert.ok(!res.text.includes("Multi-quote"), "visitors get no toggle");
  res = await req("GET", `/t/${t}`, { cookie: dan });
  assert.ok(res.text.includes("+ Multi-quote"));
  assert.ok(res.text.includes(`aria-pressed="false"`));
  assert.ok(!res.text.includes("selected to quote"));

  // ── Ticking posts on two pages ──
  const toggle = async (cookie: string, op: string, postId: number | null, back: string) =>
    req("POST", `/t/${t}/multiquote`, { cookie, form: { op, back, ...(postId !== null ? { post: String(postId) } : {}) } });
  res = await toggle(dan, "add", post(2), `/t/${t}`);
  assert.equal(res.status, 303);
  assert.equal(res.location, `/t/${t}#p${post(2)}`);
  assert.equal(res.cookie, `fb_mq=${t}%3A${post(2)}`);
  let mq = decodeURIComponent(res.cookie!);
  res = await toggle(`${dan}; ${mq}`, "add", post(late), `/t/${t}?page=2`);
  assert.equal(res.location, `/t/${t}?page=2#p${post(late)}`);
  mq = decodeURIComponent(res.cookie!);
  assert.equal(mq, `fb_mq=${t}:${post(2)}.${post(late)}`);
  const withMq = `${dan}; ${mq}`;

  res = await req("GET", `/t/${t}?page=2`, { cookie: withMq });
  assert.ok(res.text.includes("✓ Multi-quote"), "page 2 shows its selected post");
  assert.ok(res.text.includes("Reply with 2 quotes"));
  assert.ok(res.text.includes("2 posts are selected to quote."));
  assert.ok(res.text.includes("Add 2 quotes"));
  assert.ok(res.text.includes("formnovalidate"), "adding quotes doesn't need a draft");

  // ── The reply form quotes them in thread order ──
  const quote = (n: number) => `[quote=&quot;${n % 2 === 0 ? "Amy" : "Dan"}&quot; post=${post(n)}]\npost ${n} by ${n % 2 === 0 ? "Amy" : "Dan"}\n[/quote]\n`;
  res = await req("GET", `/t/${t}/reply`, { cookie: withMq });
  assert.ok(res.text.includes(quote(2) + quote(late)), "both quotes, page 1's first");
  res = await req("GET", `/t/${t}/reply?quote=${post(5)}`, { cookie: withMq });
  assert.ok(res.text.includes(quote(2) + quote(5) + quote(late)), "the Quote link joins the selection in order");
  res = await req("GET", `/t/${t}/reply?quote=${post(5)}`, { cookie: dan });
  assert.ok(res.text.includes(quote(5)) && !res.text.includes(`post=${post(2)}`), "without a selection, Quote quotes one post");

  // Quick reply's button keeps the draft, below the quotes.
  res = await req("POST", `/t/${t}/reply`, { cookie: withMq, form: { body: "my draft", action: "quote" } });
  assert.equal(res.status, 200);
  assert.ok(res.text.includes(quote(2) + quote(late) + "my draft"));
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM posts WHERE thread_id = $1", [t])).rows[0].n, PER_PAGE + 5, "nothing posted");

  // ── Unticking ──
  res = await toggle(withMq, "remove", post(2), `/t/${t}`);
  assert.equal(decodeURIComponent(res.cookie!), `fb_mq=${t}:${post(late)}`);

  // ── Only quotable posts get in ──
  res = await req("POST", "/b/back-room/new", { cookie: admin, form: { title: "Secret", body: "members only text", action: "post" } });
  const secret = threadIdFrom(res.location);
  const { rows: secretRows } = await pool.query("SELECT first_post_id FROM threads WHERE id = $1", [secret]);
  const secretPost = secretRows[0].first_post_id as number;
  res = await toggle(`${dan}; ${mq}`, "add", secretPost, `/t/${t}`);
  assert.equal(decodeURIComponent(res.cookie!), mq, "a post from another thread isn't added");
  // A hand-made cookie can't quote it either, nor a removed post.
  await pool.query("UPDATE posts SET deleted_at = now() WHERE id = $1", [post(3)]);
  const forged = `${dan}; fb_mq=${t}:${secretPost}.${post(3)}.${post(4)}`;
  res = await req("GET", `/t/${t}/reply?quote=${secretPost}`, { cookie: forged });
  assert.ok(!res.text.includes("members only text"));
  assert.ok(!res.text.includes(`post=${post(3)}`), "a removed post isn't quoted");
  assert.ok(res.text.includes(quote(4)));
  res = await req("GET", `/t/${t}`, { cookie: forged });
  assert.ok(res.text.includes("1 post is selected to quote."), "the count is of quotable posts");
  // Visitors can't see the Back Room: a 404, as everywhere.
  assert.equal((await req("POST", `/t/${secret}/multiquote`, { form: { op: "add", post: String(secretPost), back: "/" } })).status, 404);
  // A selection for another thread is ignored.
  res = await req("GET", `/t/${t}/reply`, { cookie: `${dan}; fb_mq=${secret}:${post(2)}` });
  assert.equal(draft(res.text).trim(), "");
  // Visitors can't build one.
  res = await toggle("", "add", post(2), `/t/${t}`);
  assert.equal(res.cookie, null);

  // ── At most multiquote_max ──
  const full = Array.from({ length: MAX }, (_, i) => post(i + 5));
  const fullMq = `${dan}; fb_mq=${t}:${full.join(".")}`;
  res = await toggle(fullMq, "add", post(2), `/t/${t}`);
  assert.equal(decodeURIComponent(res.cookie!), `fb_mq=${t}:${full.join(".")}`, "a full selection takes no more");
  res = await req("GET", `/t/${t}`, { cookie: fullMq });
  assert.match(res.text, /<button[^>]*disabled[^>]*>\+ Multi-quote/);
  res = await req("GET", `/t/${t}/reply?quote=${post(2)}`, { cookie: fullMq });
  assert.equal(draft(res.text).match(/\[quote=/g)?.length, MAX, "the Quote link's post bumps the last selected");
  assert.ok(res.text.includes(`post=${post(2)}`));

  // ── Posting the reply, or clearing, ends the selection ──
  res = await req("POST", `/t/${t}/reply`, { cookie: withMq, form: { body: "done", action: "post" } });
  assert.equal(res.status, 303);
  assert.match(res.cookie ?? "", /^fb_mq=$/);
  res = await req("POST", `/t/${t}/reply`, { cookie: dan, form: { body: "no selection", action: "post" } });
  assert.equal(res.cookie, null, "no selection, nothing to clear");
  res = await toggle(withMq, "clear", null, `/t/${t}?page=2`);
  assert.equal(res.location, `/t/${t}?page=2#quick-reply`);
  assert.match(res.cookie ?? "", /^fb_mq=$/);
  res = await toggle(withMq, "add", post(2), "https://evil.example/");
  assert.equal(res.location, `/#p${post(2)}`, "back is a path on this site");

  // ── The formatting script ──
  res = await req("GET", `/t/${t}/reply`, { cookie: dan });
  const src = /<script src="(\/static\/compose\.js\?v=[0-9a-f]{12})" defer=""><\/script>/.exec(res.text)?.[1];
  assert.ok(src, "the page loads the script from /static");
  assert.ok(res.text.includes("data-editor"));
  assert.equal(res.text.match(/<script/g)?.length, 1, "and no other script");
  const js = await app.request(`${ORIGIN}${src}`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type") ?? "", /^text\/javascript/);
  assert.ok((await js.text()).includes("textarea[data-editor]"));
  const csp = (await app.request(`${ORIGIN}/`)).headers.get("content-security-policy") ?? "";
  assert.ok(csp.includes("default-src 'none'"));
  assert.ok(csp.includes("script-src 'self'"));
  assert.ok(!csp.includes("unsafe-inline"));
}

run("editor", pool, main);
