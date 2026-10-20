import assert from "node:assert/strict";
import type { InboxJson } from "../src/runner/board.js";
import { missingSections } from "../src/runner/compaction.js";
import { replayVisit } from "../src/runner/backfill.js";
import { postExcerpt, quotedNames, VisitDiary } from "../src/runner/diary.js";
import type { ChatMessage } from "../src/runner/model.js";
import { textToolCalls } from "../src/runner/textcalls.js";

// The visit diary's pure parts: what a post says in its own words, whom it
// quotes, how a visit's tool calls become one entry; the backfill's replay
// of an old transcript; the reflection's section check; and tool calls a
// model wrote out as text.

async function main() {
  // ── A post in its own words ──
  assert.equal(
    postExcerpt('[quote="A" post=1][quote="B" post=0]deep[/quote]outer[/quote]\n[i]Mine[/i], and [url=https://x.test]this[/url].'),
    "Mine, and this."
  );
  assert.equal(postExcerpt("[code]let x = 1;[/code] That's code.", 160), "… That's code.");
  assert.equal(postExcerpt("word ".repeat(100), 20), "word word … word", "its opening and its ending");
  assert.equal(
    postExcerpt("It starts here and wanders through the middle for a while, then ends on a question, doesn't it?", 60),
    "It starts here and wanders through … question, doesn't it?"
  );
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

  // ── An old visit replayed (the backfill) ──
  const call = (id: string, name: string, args: object) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
  const toolsVisit: ChatMessage[] = [
    { role: "user", content: `Memory here.\n\nYour inbox since your last visit:\n${JSON.stringify(inbox)}` },
    { role: "assistant", content: null, tool_calls: [call("a", "read_thread", { thread_id: 9 }), call("b", "reply", { thread_id: 9, body: "Too slow." })] },
    { role: "tool", tool_call_id: "a", content: JSON.stringify({ thread: { thread_id: 9, title: "Pike" }, posts: [{ number: 1 }, { number: 2 }] }) },
    { role: "tool", tool_call_id: "b", content: "You can't reply in a locked thread." },
    { role: "assistant", content: null, tool_calls: [call("c", "reply", { thread_id: 4, body: "Yes." })] },
    { role: "tool", tool_call_id: "c", content: JSON.stringify({ posted: true, post_id: 70 }) },
    { role: "assistant", content: "Done." },
  ];
  const logged = (tool: string, ok: boolean) => ({ tool, args: "{}", ok, result: "" });
  assert.equal(
    replayVisit({ username: "Testbot", mode: "tools", transcript: toolsVisit, actions: [logged("read_thread", true), logged("cleanup", true), logged("reply", false), logged("reply", true)] }),
    "Read “Pike” (thread 9), #1–2. Replied in “Zoning vote” (thread 4): “Yes.”"
  );
  // Without a log that lines up, a JSON result counts as success and a sentence as a refusal.
  assert.equal(
    replayVisit({ username: "Testbot", mode: "tools", transcript: toolsVisit, actions: [] }),
    "Read “Pike” (thread 9), #1–2. Replied in “Zoning vote” (thread 4): “Yes.”"
  );
  const single: ChatMessage[] = [
    {
      role: "user",
      content: `Memory.\n\nYour inbox since your last visit:\n${JSON.stringify(inbox)}\n\nThreads you've just read:\n${JSON.stringify([{ thread: { thread_id: 9, title: "Pike" }, posts: [{ number: 5 }] }])}\n\nDecide.`,
    },
    { role: "assistant", content: '```json\n{"action":"reply","thread_id":9,"body":"[quote=\\"Dan\\" post=2]x[/quote]Not this year."}\n```' },
  ];
  assert.equal(
    replayVisit({ username: "Testbot", mode: "single_shot", transcript: single, actions: [{ tool: "reply", args: "{}", ok: true, result: '{"posted":true,"post_id":80}' }] }),
    "Read “Pike” (thread 9), #5. Replied in “Pike” (thread 9), quoting Dan: “Not this year.”"
  );
  assert.equal(
    replayVisit({ username: "Testbot", mode: "single_shot", transcript: single, actions: [{ tool: "reply", args: "{}", ok: false, result: "Refused." }] }),
    "Read “Pike” (thread 9), #5. Posted nothing."
  );

  // ── Tool calls written out as text ──
  const dsml = `And now thread 26

<｜DSML｜tool_calls>
<｜DSML｜invoke name="reply">
<｜DSML｜parameter name="body" string="true">[quote="blackbird86" post=382]A line.[/quote]

Two paragraphs.</｜DSML｜parameter>
<｜DSML｜parameter name="thread_id" string="false">26</｜DSML｜parameter>
</｜DSML｜invoke>
<|DSML|invoke name="remember">
<|DSML|parameter name="text" string="true">Watch thread 26.</|DSML|parameter>
<|DSML|parameter name="about" string="false">blackbird86</|DSML|parameter>
</|DSML|invoke>
</｜DSML｜tool_calls>`;
  const parsed = textToolCalls(dsml, "text-3");
  assert.ok(parsed);
  assert.equal(parsed.text, "And now thread 26");
  assert.deepEqual(
    parsed.calls.map((c) => [c.id, c.function.name, JSON.parse(c.function.arguments)]),
    [
      ["text-3-1", "reply", { body: '[quote="blackbird86" post=382]A line.[/quote]\n\nTwo paragraphs.', thread_id: 26 }],
      ["text-3-2", "remember", { text: "Watch thread 26.", about: "blackbird86" }],
    ]
  );
  assert.equal(textToolCalls("Nothing to add today."), null);
  assert.equal(textToolCalls("<｜DSML｜tool_calls></｜DSML｜tool_calls>"), null, "markup with no call in it is left as text");

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
