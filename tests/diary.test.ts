import assert from "node:assert/strict";
import type { InboxJson } from "../src/runner/board.js";
import { missingSections } from "../src/runner/compaction.js";
import { postExcerpt, quotedNames, VisitDiary } from "../src/runner/diary.js";

// The visit diary's pure parts: what a post says in its own words, whom it
// quotes, how a visit's tool calls become one entry; and the reflection's
// section check.

async function main() {
  // ── A post in its own words ──
  assert.equal(
    postExcerpt('[quote="A" post=1][quote="B" post=0]deep[/quote]outer[/quote]\n[i]Mine[/i], and [url=https://x.test]this[/url].'),
    "Mine, and this."
  );
  assert.equal(postExcerpt("[code]let x = 1;[/code] That's code.", 160), "… That's code.");
  assert.equal(postExcerpt("word ".repeat(100), 20), "word word word word…");
  assert.equal(postExcerpt('[quote="A"]only a quote[/quote]'), "");
  assert.deepEqual(quotedNames('[quote="Captain Boday" post=3]x[/quote][quote=jake]y[/quote][quote="captain boday" post=9]z[/quote]'), ["Captain Boday", "jake"]);

  // ── One visit, one entry ──
  const inbox = {
    unread_pms: [{ conversation_id: 7, with: ["John"], unread: 1, last_at: "2026-10-09T19:00:00Z" }],
    replies: [{ post_id: 50, thread_id: 4, thread: "Zoning vote", board: "general", author: "Dan", at: "2026-10-09T19:00:00Z" }],
    mentions: [],
    active_threads: [{ thread_id: 9, title: "Pike", board: "news", new_posts: 3 }],
    new_articles: [{ fp_article_id: 11, title: "Tolls rise", thread_id: null }],
  } as unknown as InboxJson;
  const d = new VisitDiary("Testbot");
  assert.equal(d.entry(), null, "a visit that did nothing writes nothing");
  d.learnInbox(inbox);
  d.observe("read_thread", { thread_id: 4 }, JSON.stringify({ thread: { thread_id: 4, title: "Zoning vote" }, posts: [{ number: 41 }, { number: 52 }], summary_of_earlier_posts: { through_post: 40 } }));
  d.observe("read_thread", { thread_id: 4, from_post: 3 }, JSON.stringify({ thread: { thread_id: 4, title: "Zoning vote" }, posts: [{ number: 3 }, { number: 4 }] }));
  d.observe("read_article", { fp_article_id: 11 }, JSON.stringify({ fp_article_id: 11 }));
  d.observe("read_pms", { conversation_id: 7 }, JSON.stringify({ conversation_id: 7, participants: ["John", "Testbot"] }));
  d.observe("send_pm", { conversation_id: 7, body: "Soon." }, JSON.stringify({ sent: true, conversation_id: 7 }));
  d.observe("reply", { thread_id: 9, body: '[quote="Penny" post=3]x[/quote]Agreed.' }, JSON.stringify({ posted: true, post_id: 60 }));
  d.observe("new_thread", { board: "off-topic", title: "Soup", body: "Who makes soup?" }, JSON.stringify({ posted: true, thread_id: 12, post_id: 61 }));
  d.observe("remember", { text: "x", about: "@dan" }, JSON.stringify({ remembered: true, note_id: 1, about: "Dan" }));
  d.observe("remember", { text: "y" }, JSON.stringify({ remembered: true, note_id: 2 }));
  d.observe("web_search", { query: "soup history" }, "A summary.");
  assert.equal(
    d.entry(),
    "Read “Zoning vote” (thread 4), #1–52, the first 40 as a summary; the article “Tolls rise”; your messages with John. " +
      "Answered a private message from John: “Soon.” Replied in “Pike” (thread 9), quoting Penny: “Agreed.” " +
      "Started “Soup” (thread 12) in off-topic: “Who makes soup?” Looked up “soup history” on the web. Wrote 2 notes, about Dan."
  );
  const lurker = new VisitDiary();
  lurker.observe("get_user", { username: "dan" }, JSON.stringify({ name: "Dan" }));
  assert.equal(lurker.entry(), "Read Dan's profile. Posted nothing.");

  // ── The reflection's sections ──
  assert.deepEqual(missingSections("## People\nx\n**Threads**\ny\nPositions:\nz\n### To do\nNothing."), []);
  assert.deepEqual(missingSections("## People\nDan.\n## Positions\nBridges."), ["Threads", "To do"]);
}

main()
  .then(() => console.log("diary: all tests passed"))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
