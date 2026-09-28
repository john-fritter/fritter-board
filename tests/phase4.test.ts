import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { issueBotToken, revokeBotTokens } from "../src/auth/bot-tokens.js";
import { parsePublicUrl } from "../src/config.js";
import { insertUser } from "../src/forum/accounts.js";
import { createThread, reply } from "../src/forum/threads.js";
import type { Viewer } from "../src/forum/types.js";
import { createMcpApp } from "../src/mcp/app.js";
import { createPaperSchema, FP_ORIGIN, ORIGIN, run, setup } from "./support.js";

// Phase 4 end to end: the MCP server. Tokens and the HTTP door, every tool
// against the same rules the web applies, the inbox, the write cap, the
// weekly title, moderation, and the Back Room staying hidden from a bot that
// can't see it. Clients are the MCP SDK's own, over HTTP and over stdio.

const { pool, forum, reset, req, login } = setup("phase4", { fp: true });
const mcp = createMcpApp({ forum, env: parsePublicUrl(ORIGIN, 0, FP_ORIGIN) });
const ROOT = path.join(import.meta.dirname, "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const PW = "a-long-password";

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: "phase4-test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://mcp.test/mcp"), {
      fetch: async (url, init) => mcp.fetch(new Request(url, init)),
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
  );
  return client;
}

type Result = { isError?: boolean; content: { type: string; text: string }[] };

/** Calls a tool that should succeed, and parses its JSON. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = (await client.callTool({ name, arguments: args })) as Result;
  const text = res.content[0]?.text ?? "";
  assert.ok(!res.isError, `${name} failed: ${text}`);
  return JSON.parse(text);
}

/** Calls a tool that should fail, and returns its message. */
async function refused(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = (await client.callTool({ name, arguments: args })) as Result;
  const text = res.content[0]?.text ?? "";
  assert.ok(res.isError, `${name} should have failed, got: ${text}`);
  return text;
}

/** A raw request to the MCP endpoint, for the HTTP-level checks. */
function post(headers: Record<string, string>, body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list" }) {
  return mcp.request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

async function makeBot(username: string, role: "member" | "moderator" = "member") {
  const id = await insertUser(pool, { username, password: null, isBot: true, role });
  return { id, token: await issueBotToken(pool, id) };
}

const count = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0].n as number;

async function main() {
  await reset();
  await createPaperSchema(pool);
  const startedAt = new Date(Date.now() - 1000);

  await insertUser(pool, { username: "John", password: PW, role: "admin" });
  const danId = await insertUser(pool, { username: "Dan", password: PW });
  const dan: Viewer = { id: danId, username: "Dan", role: "member", status: "active", isBot: false };
  const danCookie = await login("Dan", PW);
  const ash = await makeBot("Ash");
  const marg = await makeBot("Marg", "moderator");

  // The paper: one article from before the bots joined, one since.
  await pool.query(
    `INSERT INTO published.articles (id, published_on, ref, rank, tier, headline, body, source_count, published_at)
     VALUES (200, '2026-09-20', 'C1', 1, 'feature', 'Old news', 'Nothing new here.', 0, NOW() - INTERVAL '5 days'),
            (201, '2026-09-27', 'C2', 2, 'feature', 'Ferry fares rise', 'The ferry board raised fares by a dollar.' || E'\\n\\n' || 'Riders objected.', 2, NOW())`
  );
  await pool.query(
    `INSERT INTO published.article_sources (article_id, position, source_name, title, url)
     VALUES (201, 1, 'The Ledger', 'Fares up', 'https://ledger.test/fares'),
            (201, 2, 'Harbor Radio', 'Riders react', 'https://radio.test/riders')`
  );

  // ── The door ──
  assert.equal((await mcp.request("/health")).status, 200);
  let http = await post({});
  assert.equal(http.status, 401, "no token");
  assert.ok(http.headers.get("www-authenticate")?.startsWith("Bearer"));
  assert.equal((await post({ Authorization: "Bearer fb_nonsense" })).status, 401, "a made-up token");
  assert.equal((await post({ Authorization: `Bearer ${ash.token}`, Origin: "http://evil.test" })).status, 403, "browsers are refused");
  http = await post({ Authorization: `Bearer ${ash.token}` }, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "0" } },
  });
  assert.equal(http.status, 200);
  assert.ok(((await http.json()) as { result: { instructions: string } }).result.instructions.includes("BBCode"));

  const a = await connect(ash.token);
  const m = await connect(marg.token);

  // ── Tools on offer ──
  const ashTools = (await a.listTools()).tools.map((t) => t.name);
  const margTools = (await m.listTools()).tools.map((t) => t.name);
  for (const t of ["get_inbox", "list_boards", "list_threads", "read_thread", "read_article", "search", "get_user", "reply", "new_thread", "edit_post", "send_pm", "read_pms", "set_title"]) {
    assert.ok(ashTools.includes(t), `members have ${t}`);
  }
  assert.ok(!ashTools.some((t) => t.startsWith("mod_")), "members aren't offered moderation");
  for (const t of ["mod_lock", "mod_unlock", "mod_sticky", "mod_unsticky", "mod_move", "mod_remove_post", "mod_warn", "mod_reports", "mod_resolve_report"]) {
    assert.ok(margTools.includes(t), `moderators have ${t}`);
  }
  assert.match(await refused(a, "mod_lock", { thread_id: 1 }), /not found/i, "and can't call what they aren't offered");

  // ── Boards and threads ──
  const boards = await call(a, "list_boards");
  const slugs = boards.flatMap((c: { boards: { slug: string }[] }) => c.boards.map((b) => b.slug));
  assert.ok(slugs.includes("general") && slugs.includes("back-room"), "bots are members: they see the Back Room");

  let r = await call(a, "new_thread", { board: "general", title: "Bridges I have known", body: "Hello [b]board[/b]." });
  const t1 = r.thread_id as number;
  const ashPost1 = r.post_id as number;
  assert.equal(r.url, `${ORIGIN}/t/${t1}`);
  let res = await req("GET", `/t/${t1}`);
  assert.ok(res.text.includes("Hello <strong>board</strong>."), "a bot's post renders like anyone's");
  assert.ok(res.text.includes("BOT"), "with the badge");
  assert.match(await refused(a, "new_thread", { title: "No board", body: "x" }), /which board/);
  assert.match(await refused(a, "new_thread", { board: "general", title: "", body: "x" }), /needs a title/, "the usual validation");
  assert.match(await refused(a, "list_threads", { board: "nowhere" }), /doesn't exist/);
  const listed = await call(a, "list_threads", { board: "general" });
  assert.equal(listed.threads[0].thread_id, t1);

  // Dan answers on the web: a reply quoting Ash, and @mentions elsewhere.
  const { postId: danReply } = await reply(forum, dan, t1, `[quote="Ash" post=${ashPost1}]Hello[/quote]\nHello yourself.`);
  const { threadId: t2 } = await createThread(forum, dan, (await pool.query("SELECT id FROM boards WHERE slug = 'off-topic'")).rows[0].id, "Lunch", "Has anyone asked @Ash about lunch?");
  const backRoomId = (await pool.query("SELECT id FROM boards WHERE slug = 'back-room'")).rows[0].id as number;
  const { threadId: secret } = await createThread(forum, dan, backRoomId, "Private matters", "Just between us, @ash: the ferry.");
  // A mention inside someone's email address isn't one.
  await reply(forum, dan, t2, "Write to bob@Ashford.test instead.");

  // ── The inbox ──
  // A peek (the runner's early-wake check) neither moves the cursor nor counts
  // as being seen; any other tool call does count.
  await pool.query("UPDATE users SET last_seen_at = NULL WHERE id = $1", [ash.id]);
  let inbox = await call(a, "get_inbox", { peek: true });
  assert.equal(inbox.replies.length, 1);
  const ashRow = async () => (await pool.query("SELECT last_seen_at, inbox_checked_at FROM users WHERE id = $1", [ash.id])).rows[0];
  assert.equal((await ashRow()).last_seen_at, null, "a peek isn't being seen");
  assert.equal((await ashRow()).inbox_checked_at, null, "nor checking");
  inbox = await call(a, "get_inbox");
  assert.notEqual((await ashRow()).last_seen_at, null, "a real check is being seen");
  assert.equal(inbox.you.name, "Ash");
  assert.equal(inbox.you.posts, 1);
  assert.deepEqual(inbox.you.writes_left, { this_hour: 9, today: 49 });
  assert.deepEqual(inbox.you.write_limits, { per_hour: 10, per_day: 50 });
  assert.equal(inbox.replies.length, 1);
  assert.equal(inbox.replies[0].post_id, danReply);
  assert.equal(inbox.replies[0].quotes_you, true);
  assert.equal(inbox.replies[0].number, 2);
  assert.equal(inbox.replies[0].excerpt, "Hello yourself.", "excerpts leave out quoted text");
  assert.deepEqual(inbox.mentions.map((p: { thread_id: number }) => p.thread_id).sort(), [t2, secret].sort(), "@mentions, case-insensitive, not email addresses");
  assert.ok(inbox.mentions.every((p: { mentions_you?: boolean }) => p.mentions_you === true), "mentions are marked");
  assert.equal(inbox.replies[0].mentions_you, undefined, "a reply that doesn't name you isn't");
  const active = inbox.active_threads.map((t: { thread_id: number }) => t.thread_id);
  assert.ok(active.includes(t1) && active.includes(t2) && active.includes(secret));
  assert.equal(inbox.active_threads.find((t: { thread_id: number }) => t.thread_id === t2).new_thread, true);
  assert.deepEqual(inbox.new_articles.map((x: { fp_article_id: number }) => x.fp_article_id), [201], "only articles since the last check");
  assert.equal(inbox.new_articles[0].title, "Ferry fares rise");
  assert.equal(inbox.new_articles[0].thread_id, null);
  assert.equal(inbox.open_reports, undefined, "reports are for moderators");
  inbox = await call(a, "get_inbox");
  assert.equal(inbox.replies.length + inbox.mentions.length + inbox.active_threads.length + inbox.new_articles.length, 0, "checking moves the cursor");
  inbox = await call(a, "get_inbox", { since: startedAt.toISOString() });
  assert.equal(inbox.replies.length, 1, "unless the caller names a moment");
  assert.match(await refused(a, "get_inbox", { since: "last tuesday" }), /ISO 8601/);

  // ── Reading a thread ──
  let thread = await call(a, "read_thread", { thread_id: t1 });
  assert.equal(thread.posts[0].number, 2, "starts at the first unread post");
  assert.equal(thread.posts[0].body, `[quote="Ash" post=${ashPost1}]Hello[/quote]\nHello yourself.`, "markup as written");
  assert.equal(thread.thread.you_can_reply, true);
  assert.equal(thread.next_from, null);
  assert.equal(await count("SELECT last_read_post_id AS n FROM read_markers WHERE thread_id = $1", [t1]), danReply, "reading marks read");
  thread = await call(a, "read_thread", { thread_id: t1 });
  assert.deepEqual(thread.posts.map((p: { number: number }) => p.number), [1, 2], "caught up: the latest posts");
  thread = await call(a, "read_thread", { thread_id: t1, from_post: 1 });
  assert.equal(thread.posts[0].author.name, "Ash");
  assert.equal(thread.posts[0].author.bot, true);
  assert.equal(thread.posts[1].author.bot, undefined);

  // ── Writing ──
  r = await call(a, "reply", { thread_id: t1, body: `[quote="Dan" post=${danReply}]Hello yourself.[/quote]\nQuite.` });
  const ashPost2 = r.post_id as number;
  const html = (await pool.query("SELECT body_html FROM posts WHERE id = $1", [ashPost2])).rows[0].body_html as string;
  assert.ok(html.includes(`<a href="/p/${danReply}">Dan wrote:</a>`), "quote links match the web's");
  assert.match(await refused(a, "reply", { thread_id: t1, body: "   " }), /empty/);
  assert.match(await refused(a, "reply", { thread_id: 999999, body: "hi" }), /doesn't exist/);

  await call(a, "edit_post", { post_id: ashPost1, body: "Hello [b]board[/b], edited." });
  assert.equal(await count("SELECT COUNT(*)::int AS n FROM post_edits WHERE post_id = $1", [ashPost1]), 1, "edits keep history");
  assert.match(await refused(a, "edit_post", { post_id: danReply, body: "hijacked" }), /can't edit/);
  await call(a, "edit_post", { post_id: ashPost1, body: "Hello again.", title: "Bridges, revisited" });
  assert.equal((await pool.query("SELECT title FROM threads WHERE id = $1", [t1])).rows[0].title, "Bridges, revisited");

  // ── The paper ──
  const article = await call(a, "read_article", { fp_article_id: 201 });
  assert.ok(article.body.includes("Riders objected."), "the whole article");
  assert.deepEqual(article.sources.map((s: { name: string }) => s.name), ["The Ledger", "Harbor Radio"]);
  assert.equal(article.url, `${FP_ORIGIN}/article/201`);
  assert.match(await refused(a, "read_article", { fp_article_id: 999 }), /doesn't exist/);
  assert.match(
    await refused(a, "new_thread", { board: "general", title: "Fares", body: "Hm.", fp_article_id: 201 }),
    /start in the news board/,
    "article threads start in the discussion board"
  );
  r = await call(a, "new_thread", { title: "Ferry fares", body: "A dollar is a dollar.", fp_article_id: 201 });
  const articleThread = r.thread_id as number;
  assert.equal((await pool.query("SELECT b.slug FROM threads t JOIN boards b ON b.id = t.board_id WHERE t.id = $1", [articleThread])).rows[0].slug, "news");
  assert.match(
    await refused(m, "new_thread", { title: "Ferry again", body: "Me too.", fp_article_id: 201 }),
    new RegExp(`already has a thread \\(thread_id ${articleThread}\\)`),
    "one thread per article, and the error says where it is"
  );
  assert.equal((await call(a, "read_article", { fp_article_id: 201 })).thread_id, articleThread);

  // ── Search ──
  let found = await call(a, "search", { query: "hello" });
  assert.equal(found.total, 3);
  assert.ok(found.posts.every((p: { excerpt: string }) => !p.excerpt.includes("<")), "excerpts are text, not HTML");
  found = await call(a, "search", { query: "ferry" });
  assert.equal(found.total, 2, "members' search includes the Back Room");
  found = await call(a, "search", { scope: "mine" });
  assert.equal(found.total, 3, "scope mine lists your own posts");
  assert.ok(found.posts.every((p: { author: string }) => p.author === "Ash"));
  found = await call(a, "search", { query: "fares", scope: "articles" });
  assert.deepEqual(found.articles.map((x: { fp_article_id: number }) => x.fp_article_id), [201]);
  assert.equal(found.articles[0].thread_id, articleThread);
  assert.match(await refused(a, "search", {}), /query, an author/);

  // ── Members ──
  const profile = await call(a, "get_user", { username: "dan" });
  assert.equal(profile.name, "Dan");
  assert.equal(profile.posts, 4);
  assert.equal(profile.recent_posts.length, 4);
  assert.match(await refused(a, "get_user", { username: "nobody" }), /doesn't exist/);

  let titled = await call(a, "set_title", { title: "Reads the minutes" });
  assert.equal(titled.title, "Reads the minutes");
  assert.notEqual(titled.next_change_available, "now");
  assert.match(await refused(a, "set_title", { title: "Changed my mind" }), /again after/, "once a week");
  titled = await call(a, "set_title", { title: "Reads the minutes" });
  assert.equal(titled.title, "Reads the minutes", "setting the same title isn't a change");
  res = await req("GET", "/u/Ash");
  assert.ok(res.text.includes("Reads the minutes"));
  await pool.query("UPDATE users SET title_changed_at = NOW() - INTERVAL '8 days' WHERE id = $1", [ash.id]);
  await call(a, "set_title", { title: "" });
  assert.equal((await call(a, "get_user", { username: "Ash" })).title, "Newcomer", "an empty title falls back to rank");

  // ── Private messages ──
  assert.match(await refused(a, "send_pm", { body: "to whom?" }), /either/);
  assert.match(await refused(a, "send_pm", { to: "Ash", body: "me" }), /yourself/);
  r = await call(a, "send_pm", { to: "Dan", subject: "The bridge", body: "Did you see the [i]vote[/i]?" });
  const conv = r.conversation_id as number;
  res = await req("GET", "/pm", { cookie: danCookie });
  assert.ok(res.text.includes("The bridge"), "a bot's message arrives in a person's inbox");
  res = await req("POST", `/pm/${conv}/reply`, { cookie: danCookie, form: { body: "I did." } });
  assert.equal(res.status, 303);
  inbox = await call(a, "get_inbox");
  assert.equal(inbox.unread_pms.length, 1);
  assert.equal(inbox.unread_pms[0].unread, 1);
  assert.deepEqual(inbox.unread_pms[0].with, ["Dan"]);
  const pms = await call(a, "read_pms");
  assert.equal(pms.conversations[0].unread, true);
  const read = await call(a, "read_pms", { conversation_id: conv });
  assert.deepEqual(read.messages.map((x: { body: string }) => x.body), ["Did you see the [i]vote[/i]?", "I did."]);
  assert.equal((await call(a, "get_inbox")).unread_pms.length, 0, "reading clears it");
  await call(a, "send_pm", { conversation_id: conv, body: "Good." });
  assert.match(await refused(m, "read_pms", { conversation_id: conv }), /doesn't exist/, "other people's PMs don't exist");
  assert.match(await refused(m, "send_pm", { conversation_id: conv, body: "hi" }), /doesn't exist/);

  // ── Reports and moderation ──
  await call(a, "report_post", { post_id: danReply, reason: "Testing the report queue" });
  const margInbox = await call(m, "get_inbox");
  assert.equal(margInbox.open_reports.length, 1, "reports reach the moderator's inbox");
  assert.equal(margInbox.open_reports[0].reason, "Testing the report queue");
  const reports = await call(m, "mod_reports");
  assert.equal(reports[0].post, `[quote="Ash" post=${ashPost1}]Hello[/quote]\nHello yourself.`);
  await call(m, "mod_resolve_report", { report_id: reports[0].report_id, resolution: "Just a test" });
  assert.equal((await call(m, "mod_reports")).length, 0);

  await call(m, "mod_lock", { thread_id: t1, reason: "Cooling off" });
  assert.match(await refused(a, "reply", { thread_id: t1, body: "hey" }), /locked/, "bots respect locks");
  assert.equal((await call(a, "read_thread", { thread_id: t1 })).thread.you_can_reply, false);
  await call(m, "reply", { thread_id: t1, body: "Moderators may still post." });
  await call(m, "mod_unlock", { thread_id: t1 });
  await call(m, "mod_sticky", { thread_id: t1, reason: "Important" });
  assert.equal((await call(a, "list_threads", { board: "general" })).threads[0].sticky, true);
  await call(m, "mod_unsticky", { thread_id: t1 });
  await call(m, "mod_move", { thread_id: t2, board: "general", reason: "Belongs here" });
  await call(m, "mod_remove_post", { post_id: danReply, reason: "Off topic" });
  assert.match(await refused(m, "mod_remove_post", { post_id: danReply, reason: "again" }), /already removed/);
  thread = await call(a, "read_thread", { thread_id: t1, from_post: 2 });
  assert.equal(thread.posts[0].removed, true);
  assert.equal(thread.posts[0].body, undefined, "a removed post's text is gone");
  assert.equal(thread.posts[0].removal_reason, undefined, "and its reason is for moderators");
  thread = await call(m, "read_thread", { thread_id: t1, from_post: 2 });
  assert.equal(thread.posts[0].removal_reason, "Off topic");
  res = await req("GET", `/t/${t1}`);
  assert.ok(res.text.includes("[removed by moderator]") && !res.text.includes("Off topic"), "and the web agrees");
  await call(m, "mod_warn", { username: "Dan", reason: "Tone", message: "Please keep it civil." });
  res = await req("GET", "/pm", { cookie: danCookie });
  assert.ok(res.text.includes("A note from the moderators"));
  assert.match(await refused(m, "mod_warn", { username: "Dan", reason: "" }), /Give a reason/);
  const logged = (await pool.query("SELECT action FROM mod_actions ORDER BY id")).rows.map((x) => x.action);
  assert.deepEqual(logged, ["resolve_report", "lock", "unlock", "sticky", "unsticky", "move", "remove_post", "warn"], "every action is logged");
  res = await req("GET", "/modlog");
  assert.ok(res.text.includes("Marg") && res.text.includes("Cooling off"), "in the public mod log");

  // ── The write cap ──
  const left = (await call(a, "get_inbox")).you.writes_left;
  // 3 posts, 2 edits, 2 messages and a report; refusals and moderation don't count.
  assert.deepEqual(left, { this_hour: 2, today: 42 }, "posts, edits, PMs and reports all count");
  await pool.query("INSERT INTO bot_limits (user_id, writes_per_hour) VALUES ($1, 9)", [ash.id]);
  assert.deepEqual((await call(a, "get_inbox")).you.write_limits, { per_hour: 9, per_day: 50 }, "a bot's own limits");
  await call(a, "reply", { thread_id: t2, body: "One more." });
  assert.match(await refused(a, "reply", { thread_id: t2, body: "And another." }), /limit of 9 posts and messages an hour/);
  assert.match(await refused(a, "send_pm", { to: "Dan", body: "psst" }), /limit/, "PMs too");
  assert.match(await refused(a, "report_post", { post_id: ashPost2, reason: "x" }), /limit/, "and reports");
  // Parallel calls can't all slip under the cap.
  await pool.query("UPDATE bot_limits SET writes_per_hour = 11 WHERE user_id = $1", [ash.id]);
  const burst = await Promise.all(
    [1, 2, 3, 4].map((i) => a.callTool({ name: "reply", arguments: { thread_id: t2, body: `Burst ${i}` } }) as Promise<Result>)
  );
  assert.equal(burst.filter((x) => !x.isError).length, 2, "a burst stops exactly at the cap");
  await pool.query("UPDATE bot_limits SET writes_per_hour = 100, writes_per_day = 11 WHERE user_id = $1", [ash.id]);
  assert.match(await refused(a, "reply", { thread_id: t2, body: "x" }), /a day/);
  // Out of the way of what follows.
  await pool.query("UPDATE bot_limits SET writes_per_hour = 1000, writes_per_day = 1000 WHERE user_id = $1", [ash.id]);

  // ── Who's online ──
  res = await req("GET", "/");
  assert.ok(res.text.slice(res.text.indexOf('class="panel online"')).includes(">Ash<"), "bots show in Who's online");

  // ── A suspended bot loses the Back Room, everywhere ──
  await pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [ash.id]);
  await call(m, "mod_move", { thread_id: articleThread, board: "back-room", reason: "Members only" });
  const slugsNow = (await call(a, "list_boards")).flatMap((c: { boards: { slug: string }[] }) => c.boards.map((b) => b.slug));
  assert.ok(!slugsNow.includes("back-room"));
  assert.match(await refused(a, "list_threads", { board: "back-room" }), /doesn't exist/, "hidden is 404, not 403");
  assert.match(await refused(a, "read_thread", { thread_id: secret }), /doesn't exist/);
  inbox = await call(a, "get_inbox", { since: startedAt.toISOString() });
  const seen = JSON.stringify(inbox);
  assert.ok(!seen.includes("Private matters") && !seen.includes("between us") && !seen.includes(`"thread_id":${secret}`), "no Back Room in the inbox");
  assert.equal(inbox.new_articles[0].thread_id, null, "nor an article's thread moved there");
  const peeked = JSON.stringify(await call(a, "get_inbox", { since: startedAt.toISOString(), peek: true }));
  assert.ok(!peeked.includes("Private matters") && !peeked.includes(`"thread_id":${secret}`), "nor in a peek");
  found = await call(a, "search", { query: "ferry" });
  assert.equal(found.total, 0, "nor in search");
  assert.equal((await call(a, "search", { query: "fares", scope: "articles" })).articles[0].thread_id, null);
  assert.equal((await call(a, "read_article", { fp_article_id: 201 })).thread_id, null);
  assert.match(await refused(a, "reply", { thread_id: t2, body: "hi" }), /Only members/, "suspended bots can't post");
  assert.match(await refused(a, "send_pm", { to: "Dan", body: "hi" }), /Only members/);
  assert.equal((await call(a, "read_thread", { thread_id: t2 })).thread.thread_id, t2, "but can still read");
  await pool.query("UPDATE users SET status = 'active' WHERE id = $1", [ash.id]);

  // ── Bans, revocation, rotation ──
  await pool.query("UPDATE users SET status = 'banned' WHERE id = $1", [ash.id]);
  assert.equal((await post({ Authorization: `Bearer ${ash.token}` })).status, 401, "a banned bot's token stops working");
  await pool.query("UPDATE users SET status = 'active' WHERE id = $1", [ash.id]);
  const rotated = await issueBotToken(pool, ash.id);
  assert.equal((await post({ Authorization: `Bearer ${ash.token}` })).status, 401, "a new token retires the old");
  assert.equal((await post({ Authorization: `Bearer ${rotated}` })).status, 200);
  await revokeBotTokens(pool, ash.id);
  assert.equal((await post({ Authorization: `Bearer ${rotated}` })).status, 401, "revoked");
  assert.equal(await count("SELECT COUNT(*)::int AS n FROM bot_tokens WHERE token_hash LIKE 'fb_%'"), 0, "only hashes are stored");

  // ── When the paper can't be read ──
  await pool.query("DROP SCHEMA published CASCADE");
  const quiet = console.error;
  console.error = () => {};
  try {
    inbox = await call(m, "get_inbox");
    assert.equal(inbox.new_articles, "The paper couldn't be read just now.", "the inbox carries on without it");
    assert.match(await refused(m, "read_article", { fp_article_id: 201 }), /board hit an error/);
  } finally {
    console.error = quiet;
  }

  // ── The command line and stdio ──
  const exec = promisify(execFile);
  const env = { ...process.env, DATABASE_URL: process.env["TEST_DATABASE_URL"]!, PUBLIC_URL: ORIGIN, FP_DATABASE_URL: "" };
  const created = await exec(TSX, [path.join(ROOT, "scripts", "bot.ts"), "create", "Clank"], { env });
  const clankToken = /(fb_[A-Za-z0-9_-]+)/.exec(created.stdout)?.[1];
  assert.ok(clankToken, "the CLI prints the new token");
  await assert.rejects(
    exec(TSX, [path.join(ROOT, "scripts", "bot.ts"), "token", "Dan"], { env }),
    (err: { stderr?: string }) => /isn't a bot/.test(err.stderr ?? ""),
    "people don't get tokens"
  );
  const stdio = new Client({ name: "phase4-stdio", version: "0" });
  await stdio.connect(
    new StdioClientTransport({
      command: TSX,
      args: [path.join(ROOT, "src", "mcp", "stdio.ts")],
      env: { ...env, FRITTER_BOARD_TOKEN: clankToken } as Record<string, string>,
      stderr: "ignore",
    })
  );
  try {
    r = await call(stdio, "reply", { thread_id: t2, body: "Clank, over stdio." });
    assert.equal((await pool.query("SELECT u.username FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id = $1", [r.post_id])).rows[0].username, "Clank");
    await pool.query("UPDATE users SET status = 'banned' WHERE username = 'Clank'");
    assert.match(await refused(stdio, "get_inbox"), /no longer works/, "stdio re-checks the token on every call");
  } finally {
    await stdio.close();
  }

  await Promise.all([a.close(), m.close()]);
}

run("phase4", pool, main);
