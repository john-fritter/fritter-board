import assert from "node:assert/strict";
import { insertUser } from "../src/forum/accounts.js";
import { WARNING_SUBJECT } from "../src/forum/moderation.js";
import { reply } from "../src/forum/threads.js";
import type { Viewer } from "../src/forum/types.js";
import { ORIGIN, run, setup, threadIdFrom } from "./support.js";

// Phase 2 end to end: edits and history, read markers, search, PMs,
// moderation and the mod log, reports, member standing, RSS.

const { pool, forum, reset, req, login } = setup("phase2");

const PW = "a-long-password";

async function main() {
  await reset();
  const ids = {
    john: await insertUser(pool, { username: "John", password: PW, role: "admin" }),
    mo: await insertUser(pool, { username: "Mo", password: PW, role: "moderator" }),
    dan: await insertUser(pool, { username: "Dan", password: PW }),
    eve: await insertUser(pool, { username: "Eve", password: PW }),
  };
  const [john, mo, dan, eve] = [await login("John", PW), await login("Mo", PW), await login("Dan", PW), await login("Eve", PW)];
  const danViewer: Viewer = { id: ids.dan, username: "Dan", role: "member", status: "active", isBot: false };
  const firstPostOf = async (threadId: number) =>
    (await pool.query("SELECT first_post_id FROM threads WHERE id = $1", [threadId])).rows[0].first_post_id as number;

  let res = await req("POST", "/b/general/new", {
    cookie: dan,
    form: { title: "Zonning vote", body: "The council approved the <b>zoning</b> plan.", action: "post" },
  });
  const t1 = threadIdFrom(res.location);
  const p1 = await firstPostOf(t1);

  // ── Edits keep every version ──
  res = await req("GET", `/p/${p1}/edit`, { cookie: eve });
  assert.equal(res.status, 303, "non-authors are bounced from the edit form");
  res = await req("POST", `/p/${p1}/edit`, { cookie: eve, form: { title: "x", body: "hijacked", action: "save" } });
  assert.equal(res.status, 403);
  res = await req("POST", `/p/${p1}/edit`, { cookie: dan, form: { title: "Zoning vote", body: "draft", action: "preview" } });
  assert.ok(res.text.includes("Preview"));
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM post_edits")).rows[0].n, 0, "preview saves nothing");
  res = await req("POST", `/p/${p1}/edit`, {
    cookie: dan,
    form: { title: "Zoning vote", body: "The council approved the <b>zoning</b> plan, 7–2.", action: "save" },
  });
  assert.equal(res.status, 303);
  res = await req("GET", `/t/${t1}`);
  assert.ok(res.text.includes("<title>Zoning vote"), "editing the first post can fix the title");
  assert.ok(res.text.includes("7–2"));
  assert.ok(res.text.includes("Last edited by Dan"));
  for (const [who, cookie, status] of [["author", dan, 200], ["moderator", mo, 200], ["member", eve, 404], ["visitor", null, 404]] as const) {
    res = await req("GET", `/p/${p1}/history`, { cookie });
    assert.equal(res.status, status, `history for ${who}`);
  }
  res = await req("GET", `/p/${p1}/history`, { cookie: dan });
  assert.ok(res.text.includes("Current version") && res.text.includes("Version 1, replaced by Dan"));
  assert.ok(res.text.includes("approved the &lt;b&gt;zoning&lt;/b&gt; plan."), "old versions render escaped");

  // ── New since last visit ──
  res = await req("GET", "/b/general", { cookie: eve });
  assert.ok(res.text.includes(`/t/${t1}/unread`), "a thread posted after Eve joined is new to her");
  res = await req("GET", "/", { cookie: eve });
  assert.ok(res.text.includes("badge-new"));
  res = await req("GET", "/b/general");
  assert.ok(!res.text.includes("badge-new"), "visitors never see New");
  await req("GET", `/t/${t1}`, { cookie: eve });
  res = await req("GET", "/b/general", { cookie: eve });
  assert.ok(!res.text.includes(`/t/${t1}/unread`), "reading the thread clears it");
  const { postId: r1 } = await reply(forum, danViewer, t1, "Also: parking.");
  res = await req("GET", "/b/general", { cookie: eve });
  assert.ok(res.text.includes(`/t/${t1}/unread`), "a new reply makes it new again");
  res = await req("GET", `/t/${t1}/unread`, { cookie: eve });
  assert.equal(res.location, `/p/${r1}`, "New jumps to the first unread post");
  res = await req("POST", "/mark-read", { cookie: eve });
  assert.equal(res.status, 303);
  res = await req("GET", "/", { cookie: eve });
  assert.ok(!res.text.includes("badge-new"), "mark all read");

  // ── Search ──
  res = await req("POST", "/b/back-room/new", { cookie: dan, form: { title: "Private zoning", body: "Secret zoning chatter.", action: "post" } });
  const secret = threadIdFrom(res.location);
  res = await req("GET", "/search?q=zoning");
  assert.equal(res.status, 200);
  assert.ok(res.text.includes("1 post found"), "visitors don't find members-only posts");
  assert.ok(res.text.includes("<mark>zoning</mark>"));
  // Postgres drops tag-like tokens from excerpts; whatever remains is escaped.
  assert.ok(!res.text.includes("<b>zoning") && !res.text.includes("<b>"), "no raw HTML reaches a snippet");
  assert.ok(!res.text.includes("Secret zoning"));
  res = await req("GET", "/search?q=zoning", { cookie: eve });
  assert.ok(res.text.includes("2 posts found") && res.text.includes("Secret"));
  res = await req("GET", "/search?q=vote");
  assert.ok(res.text.includes("1 post found"), "a thread title match finds its first post");
  res = await req("GET", "/search?author=dan");
  assert.ok(res.text.includes("2 posts found"), "author-only search lists a member's visible posts");
  res = await req("GET", "/search?q=zoning&board=back-room");
  assert.equal(res.status, 404, "can't search a board you can't see");
  res = await req("GET", `/search?q=${encodeURIComponent('"no such phrase anywhere"')}`);
  assert.ok(res.text.includes("0 posts found"));

  // ── Private messages ──
  res = await req("GET", "/pm");
  assert.equal(res.status, 303, "visitors are sent to log in");
  res = await req("POST", "/pm/new", { cookie: dan, form: { to: "dan", subject: "hi", body: "me" } });
  assert.equal(res.status, 400, "no messages to yourself");
  res = await req("POST", "/pm/new", { cookie: dan, form: { to: "nobody", subject: "hi", body: "?" } });
  assert.equal(res.status, 400);
  res = await req("POST", "/pm/new", { cookie: dan, form: { to: "eve", subject: "Lunch?", body: "Are you free [b]Friday[/b]?" } });
  assert.equal(res.status, 303);
  const convPath = res.location!;
  res = await req("GET", "/", { cookie: eve });
  assert.ok(res.text.includes("Messages (1)"));
  res = await req("GET", "/pm", { cookie: eve });
  assert.ok(res.text.includes("Lunch?") && res.text.includes("badge-new"));
  res = await req("GET", convPath, { cookie: eve });
  assert.ok(res.text.includes("<strong>Friday</strong>"));
  res = await req("GET", "/", { cookie: eve });
  assert.ok(!res.text.includes("Messages (1)"), "reading clears the count");
  res = await req("POST", `${convPath}/reply`, { cookie: eve, form: { body: "Yes." } });
  assert.equal(res.status, 303);
  res = await req("GET", "/", { cookie: dan });
  assert.ok(res.text.includes("Messages (1)"));
  assert.equal((await req("GET", convPath, { cookie: mo })).status, 404, "moderators can't read other people's PMs");
  assert.equal((await req("POST", `${convPath}/reply`, { cookie: john, form: { body: "hi" } })).status, 404, "the admin reads but can't reply");
  res = await req("GET", convPath, { cookie: john });
  assert.equal(res.status, 200, "the admin can read every conversation");
  assert.ok(res.text.includes("reading this conversation as the admin"));
  res = await req("GET", "/", { cookie: dan });
  assert.ok(res.text.includes("Messages (1)"), "the admin reading doesn't mark it read for Dan");
  res = await req("GET", "/admin/pms", { cookie: john });
  assert.ok(res.text.includes("Lunch?"));
  assert.equal((await req("GET", "/admin/pms", { cookie: mo })).status, 404);

  // ── Thread moderation ──
  res = await req("POST", `/t/${t1}/mod`, { cookie: eve, form: { action: "lock", reason: "" } });
  assert.equal(res.status, 404, "members can't moderate");
  res = await req("POST", `/t/${t1}/mod`, { cookie: mo, form: { action: "lock", reason: "Cooling off" } });
  assert.equal(res.status, 303);
  assert.equal((await req("POST", `/t/${t1}/reply`, { cookie: dan, form: { body: "hey", action: "post" } })).status, 403);
  await req("POST", `/t/${t1}/mod`, { cookie: mo, form: { action: "unlock", reason: "" } });
  await req("POST", `/t/${t1}/mod`, { cookie: mo, form: { action: "sticky", reason: "Important" } });
  res = await req("GET", "/b/general");
  assert.ok(res.text.includes("Sticky"));
  res = await req("POST", `/t/${t1}/mod`, { cookie: mo, form: { action: "move", board: "off-topic", reason: "Wrong board" } });
  assert.equal(res.status, 303);
  const boards = await pool.query("SELECT slug, thread_count, post_count FROM boards WHERE slug IN ('general', 'off-topic') ORDER BY slug");
  assert.deepEqual(boards.rows, [
    { slug: "general", thread_count: 0, post_count: 0 },
    { slug: "off-topic", thread_count: 1, post_count: 2 },
  ]);

  // ── Removing and restoring posts ──
  res = await req("POST", `/p/${r1}/moderate`, { cookie: mo, form: { action: "remove", reason: "" } });
  assert.equal(res.status, 400, "removal needs a reason");
  res = await req("POST", `/p/${r1}/moderate`, { cookie: eve, form: { action: "remove", reason: "x" } });
  assert.equal(res.status, 404);
  res = await req("POST", `/p/${r1}/moderate`, { cookie: mo, form: { action: "remove", reason: "Off topic" } });
  assert.equal(res.status, 303);
  res = await req("GET", `/t/${t1}`, { cookie: eve });
  assert.ok(res.text.includes("[removed by moderator]"));
  assert.ok(!res.text.includes("Also: parking.") && !res.text.includes("Off topic"), "members see neither text nor reason");
  res = await req("GET", `/t/${t1}`, { cookie: mo });
  assert.ok(res.text.includes("Reason: Off topic"));
  assert.equal((await pool.query("SELECT post_count FROM users WHERE id = $1", [ids.dan])).rows[0].post_count, 2);
  res = await req("GET", "/search?q=parking");
  assert.ok(res.text.includes("0 posts found"), "removed posts leave search");
  res = await req("POST", `/p/${r1}/moderate`, { cookie: mo, form: { action: "restore", reason: "" } });
  assert.equal(res.status, 404, "only the admin reverses a removal");
  res = await req("POST", `/p/${r1}/moderate`, { cookie: john, form: { action: "restore", reason: "Fair enough" } });
  assert.equal(res.status, 303);
  res = await req("GET", `/t/${t1}`);
  assert.ok(res.text.includes("Also: parking."));

  // ── Reports ──
  assert.equal((await req("GET", `/p/${r1}/report`)).status, 303, "visitors log in to report");
  res = await req("POST", `/p/${r1}/report`, { cookie: eve, form: { reason: "Spam about parking" } });
  assert.equal(res.status, 303);
  res = await req("GET", "/", { cookie: mo });
  assert.ok(res.text.includes("Reports (1)"));
  res = await req("GET", "/", { cookie: eve });
  assert.ok(!res.text.includes("Reports"), "members don't see the report queue");
  assert.equal((await req("GET", "/mod/reports", { cookie: eve })).status, 404);
  res = await req("GET", "/mod/reports", { cookie: mo });
  assert.ok(res.text.includes("Spam about parking"));
  const reportId = (await pool.query("SELECT id FROM reports")).rows[0].id as number;
  res = await req("POST", `/mod/reports/${reportId}/resolve`, { cookie: mo, form: { resolution: "Not spam" } });
  assert.equal(res.status, 303);
  res = await req("GET", "/", { cookie: mo });
  assert.ok(!res.text.includes("Reports (1)"));

  // ── Warnings arrive by PM ──
  res = await req("POST", "/u/Dan/warn", { cookie: eve, form: { reason: "x", message: "" } });
  assert.equal(res.status, 404);
  res = await req("POST", "/u/Dan/warn", { cookie: mo, form: { reason: "Tone", message: "Please keep it civil." } });
  assert.equal(res.status, 303);
  res = await req("GET", "/pm", { cookie: dan });
  assert.ok(res.text.includes(WARNING_SUBJECT));

  // ── Standing: suspend, ban, reinstate (admin only) ──
  res = await req("POST", "/u/Dan/status", { cookie: mo, form: { status: "suspended", reason: "x" } });
  assert.equal(res.status, 404, "moderators can't change membership");
  res = await req("POST", "/u/Dan/status", { cookie: john, form: { status: "suspended", reason: "" } });
  assert.equal(res.status, 400, "needs a reason");
  res = await req("POST", "/u/Dan/status", { cookie: john, form: { status: "suspended", reason: "A week off" } });
  assert.equal(res.status, 303);
  assert.equal((await req("POST", `/t/${t1}/reply`, { cookie: dan, form: { body: "hi", action: "post" } })).status, 403);
  assert.equal((await req("GET", `/t/${secret}`, { cookie: dan })).status, 404, "suspended members lose the Back Room");
  assert.equal((await req("GET", `/t/${t1}`, { cookie: dan })).status, 200, "but can still read");
  res = await req("POST", "/u/Dan/status", { cookie: john, form: { status: "banned", reason: "Enough" } });
  assert.equal(res.status, 303);
  assert.equal((await req("GET", "/settings", { cookie: dan })).status, 303, "banning ends sessions");
  res = await req("POST", "/login", { form: { username: "Dan", password: PW, next: "/" } });
  assert.equal(res.status, 403);
  await req("POST", "/u/Dan/status", { cookie: john, form: { status: "active", reason: "Second chance" } });
  await login("Dan", PW);

  // ── The public mod log, with the Back Room redacted ──
  await req("POST", `/t/${secret}/mod`, { cookie: mo, form: { action: "lock", reason: "Private matter" } });
  res = await req("GET", "/modlog");
  assert.equal(res.status, 200);
  for (const text of ["Locked", "Cooling off", "Moved", "from general to off-topic", "Removed", "Off topic", "Restored", "Warned", "Tone", "Suspended", "Banned", "Reinstated", "Resolved"]) {
    assert.ok(res.text.includes(text), `mod log shows ${text}`);
  }
  assert.ok(res.text.includes("something in a members-only board"));
  assert.ok(!res.text.includes("Private zoning") && !res.text.includes("Private matter"), "Back Room actions are redacted for visitors");
  res = await req("GET", "/modlog", { cookie: eve });
  assert.ok(res.text.includes("Private zoning") && res.text.includes("Private matter"));

  // ── RSS ──
  res = await req("GET", "/b/off-topic/rss.xml");
  assert.equal(res.status, 200);
  assert.ok(res.text.startsWith("<?xml"));
  assert.ok(res.text.includes("<title>Zoning vote</title>"));
  assert.ok(res.text.includes(`<link>${ORIGIN}/t/${t1}</link>`));
  // The description carries the post's HTML as text, so the post's own escaping is escaped again.
  assert.ok(res.text.includes("&amp;lt;b&amp;gt;zoning"), "post HTML is escaped inside the XML");
  assert.ok(!res.text.includes("<b>"));
  assert.equal((await req("GET", "/b/back-room/rss.xml", { cookie: eve })).status, 404, "the Back Room has no feed, even for members");
  res = await req("POST", `/t/${t1}/mod`, { cookie: mo, form: { action: "move", board: "back-room", reason: "" } });
  res = await req("GET", "/b/off-topic/rss.xml");
  assert.ok(!res.text.includes("Zoning vote"), "moving a thread into the Back Room takes it out of public feeds");
  assert.equal((await req("GET", `/t/${t1}`)).status, 404);
}

run("phase2", pool, main);
