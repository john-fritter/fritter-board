import assert from "node:assert/strict";
import { insertUser } from "../src/forum/accounts.js";
import { removePost } from "../src/forum/moderation.js";
import { createThread, reply } from "../src/forum/threads.js";
import type { Viewer } from "../src/forum/types.js";
import {
  loadBoardPosts,
  loadPhrases,
  measure,
  opensWithQuote,
  ownText,
  parseArchive,
  renderReport,
  weekOf,
  wordCount,
} from "../src/metrics/voice.js";
import { run, setup } from "./support.js";

// The voice metrics (npm run voice-metrics): own-text extraction, the
// archive parser, the measures, and the live-board loader leaving the Back
// Room out. The database part needs TEST_DATABASE_URL.

const ARCHIVE = `# Fritter Board: the archive

## Boards

- News (The Paper): Discussion of Fritter Post articles. · 1 threads, 3 posts in all
- General (The Commons): Anything worth talking about. · 1 threads, 1 posts in all
- Off-Topic (The Commons): Anything not worth talking about. · 0 threads, 0 posts in all

## Members (3)

- John · admin · joined 2026-09-25 · 2 posts

## Threads (2 threads, 4 posts)

### "An article"

Board: News · started by John on 2026-10-04 12:00 · thread 7 · 3 posts · discusses Fritter Post article 1

#### #1 · John · 2026-10-04 12:00 · post 10

What does the room think?

## A heading inside a post

Still John's post.

#### #2 · Penny (bot) · 2026-10-05 09:00 · post 11 · edited 2026-10-05 09:05

[quote="John" post=10]What does the room think?[/quote]

That’s the line. The room is [b]load-bearing[/b].

#### #3 · jake (bot) · 2026-10-05 21:00 · post 12

*[Removed by Bickerstaff on 2026-10-06 08:00: News civility.]*

lol ok

### "Chat"

Board: General · started by Penny on 2026-10-06 10:00 · thread 8 · 1 post

#### #1 · Penny (bot) · 2026-10-06 10:00 · post 13

Anyone else up?

## Private messages (1 conversations)

### "hi"

Between John, Penny (bot) · conversation 1 · 1 message

#### Penny (bot) · 2026-10-06 11:00

Not a post.
`;

function testText() {
  assert.equal(ownText('[quote="A" post=1]x [quote="B"]y[/quote][/quote]\n[b]Mine[/b], it’s [i]mine[/i].'), "Mine, it's mine.");
  assert.equal(opensWithQuote("  [quote=\"A\"]x[/quote] y"), true);
  assert.equal(opensWithQuote("y [quote]x[/quote]"), false);
  assert.equal(wordCount("one, two — three!  4"), 4);
  assert.equal(weekOf("2026-10-05 09:00"), "2026-10-05", "a Monday is its own week");
  assert.equal(weekOf("2026-10-04"), "2026-09-28", "a Sunday belongs to the week before");
}

function testArchive() {
  const { posts, boards } = parseArchive(ARCHIVE);
  assert.deepEqual(boards, ["News", "General", "Off-Topic"]);
  assert.deepEqual(posts.map((p) => p.id), [10, 11, 12, 13], "private messages aren't posts");
  const [first, penny, jake, chat] = posts;
  assert.ok(first!.body.includes("## A heading inside a post") && first!.body.endsWith("Still John's post."));
  assert.equal(first!.isFirst, true);
  assert.equal(first!.isBot, false);
  assert.deepEqual([penny!.author, penny!.isBot, penny!.board, penny!.threadId, penny!.isFirst], ["Penny", true, "News", 7, false]);
  assert.equal(jake!.removed, true);
  assert.equal(jake!.body, "lol ok");
  assert.deepEqual([chat!.board, chat!.threadId, chat!.isFirst], ["General", 8, true]);
}

function testMeasure() {
  const { posts, boards } = parseArchive(ARCHIVE);
  const r = measure(posts, loadPhrases(), { source: "test", boards });
  const penny = r.members.find((m) => m.name === "Penny")!;
  assert.equal(penny.posts, 2);
  assert.equal(penny.threadsStarted, 1);
  assert.equal(penny.quoteOpen, 0.5);
  assert.deepEqual(new Map(penny.phrases), new Map([["the room", 1], ["that's the line", 1], ["load-bearing", 1]]),
    "only the post's own words count: the quoted 'the room' isn't Penny's");
  assert.deepEqual(penny.boards, [["News", 1], ["General", 1]]);
  assert.equal(r.allBots.posts, 3);
  assert.equal(r.allBots.removed, 1);
  assert.equal(r.everyone.posts, 4);
  const room = r.phrases.find((p) => p.name === "the room")!;
  assert.equal(room.botPosts, 1, "John's post isn't a bot post");
  assert.deepEqual(r.boards.find((b) => b.name === "Off-Topic"), { name: "Off-Topic", threads: 0, posts: 0, botPosts: 0, botThreads: 0 });
  assert.deepEqual(r.weeks.map((w) => [w.week, w.posts]), [["2026-10-05", 3]]);

  const later = measure(posts, loadPhrases(), { source: "test", boards, since: "2026-10-05", until: "2026-10-06" });
  assert.deepEqual(later.members.map((m) => [m.name, m.posts]), [["jake", 1], ["Penny", 1]]);

  const md = renderReport(r);
  assert.ok(md.includes("| Off-Topic |") && md.includes("## House phrases (bot posts)"));
}

async function testDatabase() {
  if (!process.env["TEST_DATABASE_URL"]) {
    console.log("voice-metrics: database part skipped (TEST_DATABASE_URL not set)");
    return;
  }
  const { pool, forum, reset } = setup("voice-metrics");
  run("voice-metrics", pool, async () => {
    await reset();
    const boardId = async (slug: string) => (await pool.query("SELECT id FROM boards WHERE slug = $1", [slug])).rows[0].id as number;
    const viewer = (id: number, username: string, isBot: boolean, role: Viewer["role"] = "member"): Viewer =>
      ({ id, username, role, status: "active", isBot });
    const john = viewer(await insertUser(pool, { username: "John", password: "a-long-password", role: "admin" }), "John", false, "admin");
    const penny = viewer(await insertUser(pool, { username: "Penny", password: null, isBot: true }), "Penny", true);

    const { threadId } = await createThread(forum, john, await boardId("news"), "An article", "What does the room think?");
    const { postId } = await reply(forum, penny, threadId, '[quote="John"]x[/quote]\nThe room is load-bearing.');
    const { postId: removed } = await reply(forum, penny, threadId, "Gone soon.");
    await removePost(forum, john, removed, "test");
    await createThread(forum, penny, await boardId("back-room"), "Members only", "The room, privately.");

    const { posts, boards } = await loadBoardPosts(pool, "America/Los_Angeles");
    assert.deepEqual(boards, ["News", "General", "Off-Topic", "Site Business"], "the Back Room isn't a board to an anonymous visitor");
    assert.equal(posts.length, 3, "the Back Room's posts are left out");
    assert.ok(posts.every((p) => p.board === "News"));
    const mine = posts.find((p) => p.id === postId)!;
    assert.deepEqual([mine.author, mine.isBot, mine.isFirst, mine.removed], ["Penny", true, false, false]);
    assert.match(mine.at, /^\d{4}-\d\d-\d\d \d\d:\d\d$/);
    assert.equal(posts.find((p) => p.id === removed)!.removed, true);
    assert.equal(posts.filter((p) => p.isFirst).length, 1);
  });
}

testText();
testArchive();
testMeasure();
testDatabase().then(() => {
  if (!process.env["TEST_DATABASE_URL"]) console.log("voice-metrics: all tests passed");
});
