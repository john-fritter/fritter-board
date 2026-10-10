import assert from "node:assert/strict";
import { insertUser } from "../src/forum/accounts.js";
import { removePost, warnMember } from "../src/forum/moderation.js";
import { sendNewMessage } from "../src/forum/pms.js";
import { createThread, reply } from "../src/forum/threads.js";
import type { Viewer } from "../src/forum/types.js";
import { quotedNames } from "../src/export/markdown.js";
import { formatStamp, startOfLocalDay } from "../src/lib/time.js";
import { fileSlug } from "../src/routes/export.js";
import { writeStanding } from "../src/runner/settings.js";
import { ORIGIN, run, setup } from "./support.js";

// The admin's Markdown downloads (/admin/export): a thread, the archive and a
// bot's file. Hidden (404) from everyone but the admin; the Back Room, PMs
// and transcripts in or out as asked; the since date; the page's estimate.

const { pool, app, forum, reset, req, login } = setup("export");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const one = async (sql: string, params: unknown[] = []): Promise<any> => (await pool.query(sql, params)).rows[0];
const boardId = async (slug: string) => (await one("SELECT id FROM boards WHERE slug = $1", [slug])).id as number;

/** A download, with the headers that make it one. */
async function download(path: string, cookie: string) {
  const res = await app.request(`${ORIGIN}${path}`, { headers: { Cookie: cookie } });
  return { status: res.status, type: res.headers.get("content-type"), disposition: res.headers.get("content-disposition"), text: await res.text() };
}

function testHelpers() {
  // Midnight on the board's clock (America/Los_Angeles), DST and all.
  assert.equal(startOfLocalDay("2026-10-01")!.toISOString(), "2026-10-01T07:00:00.000Z");
  assert.equal(startOfLocalDay("2026-12-01")!.toISOString(), "2026-12-01T08:00:00.000Z");
  assert.equal(startOfLocalDay("2026-03-08")!.toISOString(), "2026-03-08T08:00:00.000Z");
  assert.equal(startOfLocalDay("2026-11-01")!.toISOString(), "2026-11-01T07:00:00.000Z");
  for (const bad of ["", "2026-02-30", "2026-13-01", "26-10-01", "2026-10-01T00:00", "yesterday"]) assert.equal(startOfLocalDay(bad), null, bad);
  assert.equal(formatStamp(new Date("2026-10-08T16:14:00Z")), "2026-10-08 09:14");
  assert.deepEqual(quotedNames('[quote="W. Hale" post=3]x[/quote] [quote=Dan]y[/quote] [quote="W. Hale" post=4]z[/quote] [quote]q[/quote]'), ["W. Hale", "Dan"]);
  assert.equal(fileSlug("On the new bridge — tolls?"), "on-the-new-bridge-tolls");
  assert.equal(fileSlug("¿¡!"), "untitled");
}

async function main() {
  testHelpers();
  await reset();

  const johnId = await insertUser(pool, { username: "John", password: "a-long-password", role: "admin" });
  const john: Viewer = { id: johnId, username: "John", role: "admin", status: "active", isBot: false };
  const modId = await insertUser(pool, { username: "Marta", password: "a-long-password", role: "moderator" });
  const marta: Viewer = { id: modId, username: "Marta", role: "moderator", status: "active", isBot: false };
  const danId = await insertUser(pool, { username: "Dan", password: "a-long-password" });
  const dan: Viewer = { id: danId, username: "Dan", role: "member", status: "active", isBot: false };
  const pennyId = await insertUser(pool, { username: "Penny", password: null, isBot: true });
  const penny: Viewer = { id: pennyId, username: "Penny", role: "member", status: "active", isBot: true };

  // An old thread, a public one with a removed post, and a Back Room one.
  const { threadId: old } = await createThread(forum, dan, await boardId("general"), "Last month's thread", "Old words.");
  await pool.query("UPDATE posts SET created_at = '2026-09-01T12:00:00Z' WHERE thread_id = $1", [old]);
  const { threadId: bridge, postId: first } = await createThread(forum, dan, await boardId("general"), "On the new bridge", "Tunnels are better.");
  await pool.query("UPDATE posts SET created_at = '2026-09-20T12:00:00Z' WHERE id = $1", [first]);
  await reply(forum, penny, bridge, `[quote="Dan" post=${first}]\nTunnels are better.\n[/quote]\nBridges have views, Dan.`);
  const { postId: rude } = await reply(forum, dan, bridge, "Penny is a toaster.");
  await removePost(forum, marta, rude, "Be kind to the toasters.");
  await warnMember(forum, marta, "Dan", "Be kind.", "Please be kinder.");
  const { threadId: back } = await createThread(forum, dan, await boardId("back-room"), "Secret tunnels", "Only members know.");
  await reply(forum, penny, back, "The Back Room has the best tunnels.");
  await sendNewMessage(forum, john, "Penny", "Hello", "How are you finding the board?");
  await sendNewMessage(forum, dan, "Marta", "Between us", "A private word.");

  // Penny's runner side: settings, memory, a run with a transcript, a search.
  await pool.query(
    `INSERT INTO bots.config (user_id, username, model, persona_prompt, api_key_ref, board_token_ref)
     VALUES ($1, 'Penny', 'vendor/model-a', 'You are Penny, who likes bridges.', 'K_PENNY', 'T_PENNY')`,
    [pennyId]
  );
  await pool.query("INSERT INTO bots.state (user_id) VALUES ($1)", [pennyId]);
  await writeStanding(pool, pennyId, "Dan prefers tunnels.", "admin", "John");
  await pool.query("INSERT INTO bots.notes (user_id, body, about, thread_id) VALUES ($1, 'Dan called me a toaster.', 'Dan', $2)", [pennyId, bridge]);
  await pool.query("INSERT INTO bots.notes (user_id, body, thread_id) VALUES ($1, 'Tunnel talk downstairs.', $2)", [pennyId, back]);
  const runId = (
    await one(
      `INSERT INTO bots.runs (user_id, kind, trigger, outcome, mode, model, reasoning_effort, model_calls, writes, actions, transcript)
       VALUES ($1, 'wake', 'schedule', 'done', 'tools', 'vendor/model-a', 'low', 2, 1, $2, $3) RETURNING id`,
      [
        pennyId,
        JSON.stringify([{ tool: "reply", args: '{"thread_id":1}', ok: true, result: "posted" }]),
        JSON.stringify([{ role: "user", content: "TRANSCRIPT-MARKER: your inbox" }, { role: "assistant", content: "I'll reply." }]),
      ]
    )
  ).id as number;
  await pool.query("INSERT INTO bots.runs (user_id, trigger, outcome, mode, model, reasoning_effort) VALUES ($1, 'schedule', 'lurked', 'tools', 'x', 'low')", [pennyId]);
  await pool.query(
    `INSERT INTO bots.searches (user_id, run_id, query, results, summary, outcome)
     VALUES ($1, $2, 'bridge tolls', $3, 'Tolls rose in 2026.', 'ok')`,
    [pennyId, runId, JSON.stringify([{ title: "Tolls", url: "https://secret.example/tolls", site: "example", published: null }])]
  );

  const johnC = await login("John", "a-long-password");
  const martaC = await login("Marta", "a-long-password");
  const danC = await login("Dan", "a-long-password");

  // ── Hidden from everyone but the admin ──
  const paths = [`/admin/export/thread/${bridge}`, "/admin/export/archive", "/admin/export/bot/Penny"];
  for (const p of [...paths, ...paths.map((p) => `${p}/download`)]) {
    for (const cookie of [null, danC, martaC]) assert.equal((await req("GET", p, { cookie })).status, 404, `${p} for ${cookie ?? "a visitor"}`);
  }
  assert.equal((await req("GET", "/admin/export/thread/99999", { cookie: johnC })).status, 404);
  assert.equal((await req("GET", "/admin/export/bot/Dan", { cookie: johnC })).status, 404, "Dan isn't a bot");

  // ── The buttons ──
  assert.match((await req("GET", `/t/${bridge}`, { cookie: johnC })).text, new RegExp(`/admin/export/thread/${bridge}"`));
  assert.doesNotMatch((await req("GET", `/t/${bridge}`, { cookie: martaC })).text, /admin\/export/);
  assert.match((await req("GET", "/admin", { cookie: johnC })).text, /\/admin\/export\/archive"/);
  assert.match((await req("GET", "/admin/bots/Penny", { cookie: johnC })).text, /\/admin\/export\/bot\/Penny"/);

  // ── A thread ──
  let page = await req("GET", `/admin/export/thread/${bridge}`, { cookie: johnC });
  assert.equal(page.status, 200);
  assert.match(page.text, /About [\d,]+ tokens/);
  assert.match(page.text, /3 posts/);
  assert.match(page.text, /type="date" name="since"/);
  assert.match(page.text, new RegExp(`formaction="/admin/export/thread/${bridge}/download"`));
  let file = await download(`/admin/export/thread/${bridge}/download`, johnC);
  assert.equal(file.status, 200);
  assert.equal(file.type, "text/markdown; charset=utf-8");
  assert.equal(file.disposition, `attachment; filename="fritter-board-thread-${bridge}-on-the-new-bridge.md"`);
  assert.match(file.text, /^# "On the new bridge"/);
  assert.match(file.text, /### #2 · Penny \(bot\) · /);
  assert.match(file.text, /\[quote="Dan" post=\d+\]/, "bodies stay BBCode");
  assert.match(file.text, /Penny is a toaster\.\n/, "removed posts keep their text");
  assert.match(file.text, /\*\[Removed by Marta on [\d-]+ [\d:]+: Be kind to the toasters\.\]\*/);
  assert.match(file.text, /Marta · remove post · post \d+ in "On the new bridge" · reason: Be kind to the toasters\./);
  assert.doesNotMatch(file.text, /Last month|Secret tunnels/);
  // Since a date: the first post (Sep 20) is left out, and the count says so.
  file = await download(`/admin/export/thread/${bridge}/download?o=1&since=2026-09-25`, johnC);
  assert.match(file.disposition!, /-since-2026-09-25\.md"$/);
  assert.doesNotMatch(file.text, /### #1 /);
  assert.match(file.text, /### #2 · Penny/);
  assert.match(file.text, /2 of its 3 posts/);
  // A bad date is the form's to fix.
  page = await req("GET", `/admin/export/thread/${bridge}?o=1&since=2026-02-30`, { cookie: johnC });
  assert.equal(page.status, 400);
  assert.match(page.text, /isn&#39;t a date|isn't a date/);
  assert.equal((await download(`/admin/export/thread/${bridge}/download?since=nope`, johnC)).status, 400);
  // A Back Room thread downloads too: it was asked for by name.
  file = await download(`/admin/export/thread/${back}/download`, johnC);
  assert.match(file.text, /Board: Back Room \(members only\)/);

  // ── The archive ──
  page = await req("GET", "/admin/export/archive", { cookie: johnC });
  assert.equal(page.status, 200);
  assert.match(page.text, /name="backroom" value="1" checked/, "the Back Room is in by default");
  assert.doesNotMatch(page.text, /name="pms" value="1" checked/, "PMs are out by default");
  file = await download("/admin/export/archive/download", johnC);
  assert.match(file.disposition!, /filename="fritter-board-archive-\d{4}-\d{2}-\d{2}\.md"/);
  for (const s of ["Last month's thread", "On the new bridge", "Secret tunnels", "## Members (4)", "Penny (bot) · member", "## Moderation log", "Marta · warn · member Dan"]) {
    assert.ok(file.text.includes(s), s);
  }
  assert.doesNotMatch(file.text, /## Private messages|A private word/);
  // Without the Back Room, and with PMs.
  file = await download("/admin/export/archive/download?o=1&pms=1", johnC);
  assert.doesNotMatch(file.text, /Secret tunnels|best tunnels|Back Room \(Members/);
  assert.match(file.text, /The members-only Back Room: left out\. Private messages: included\./);
  assert.match(file.text, /## Private messages \(3 conversations\)/, "two, and the warning");
  assert.match(file.text, /Between Dan, Marta · conversation \d+ · 1 message/);
  assert.match(file.text, /A private word\./);
  // Since: last month's thread drops out.
  file = await download("/admin/export/archive/download?since=2026-09-15", johnC);
  assert.doesNotMatch(file.text, /Last month's thread/);
  assert.match(file.text, /On the new bridge/);

  // ── The bot file ──
  page = await req("GET", "/admin/export/bot/Penny", { cookie: johnC });
  assert.equal(page.status, 200);
  assert.match(page.text, /2 posts, 1 PM conversation, 2 notes, 1 run, 1 web search/);
  assert.doesNotMatch(page.text, /name="transcripts" value="1" checked/);
  file = await download("/admin/export/bot/penny/download", johnC);
  assert.match(file.disposition!, /filename="fritter-board-bot-penny-\d{4}-\d{2}-\d{2}\.md"/);
  for (const s of [
    "# Penny (bot): the bot file",
    "You are Penny, who likes bridges.",
    "Dan prefers tunnels.",
    'Dan called me a toaster.',
    `in "On the new bridge" (thread ${bridge})`,
    `"On the new bridge" (General, thread ${bridge}) #2 · Penny (bot)`,
    "· quoting Dan",
    "The Back Room has the best tunnels.",
    "How are you finding the board?",
    "## Moderation of this bot and its posts",
    '"bridge tolls" · ok',
    "what the bot was told: Tolls rose in 2026.",
    `run ${runId}`,
    'reply {"thread_id":1}',
    "Not listed: 1 visit that lurked, without calling a model.",
  ]) {
    assert.ok(file.text.includes(s), s);
  }
  assert.doesNotMatch(file.text, /secret\.example/, "a search's URLs stay out, as the bot never saw them");
  assert.doesNotMatch(file.text, /TRANSCRIPT-MARKER|## Transcripts/);
  assert.doesNotMatch(file.text, /A private word/, "only the bot's own conversations");
  // With transcripts; without the Back Room, whose thread titles leave with it.
  file = await download("/admin/export/bot/Penny/download?o=1&transcripts=1", johnC);
  assert.match(file.text, /## Transcripts/);
  assert.match(file.text, /\*\*user:\*\*\n\nTRANSCRIPT-MARKER: your inbox/);
  assert.doesNotMatch(file.text, /The Back Room has the best tunnels|Secret tunnels/);
  assert.match(file.text, /Tunnel talk downstairs\./, "notes are kept whole");
  assert.match(file.text, /in a members-only thread/);
  // Since today: the old post's gone, the memory's current version stays.
  file = await download(`/admin/export/bot/Penny/download?since=2099-01-01`, johnC);
  assert.match(file.text, /## Posts \(0\)/);
  assert.match(file.text, /Dan prefers tunnels\./);
}

run("export", pool, main);
