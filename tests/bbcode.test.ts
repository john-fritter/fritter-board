import assert from "node:assert/strict";
import { parseQuoteAttr, quoteFor, renderBBCode } from "../src/markup/bbcode.js";

const opts = { postUrl: (id: number) => `/p/${id}` };
const r = (s: string) => renderBBCode(s, opts);

function testHtmlIsAlwaysEscaped() {
  assert.equal(r(`<script>alert("x")</script>`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  assert.equal(r(`[b]<img src=x onerror=1>[/b]`), "<strong>&lt;img src=x onerror=1&gt;</strong>");
}

function testSimpleTags() {
  assert.equal(r("[b]bold[/b] [i]it[/i] [u]u[/u] [s]gone[/s]"),
    "<strong>bold</strong> <em>it</em> <u>u</u> <s>gone</s>");
  assert.equal(r("[B]caps[/B]"), "<strong>caps</strong>");
}

function testNewlinesBecomeBreaks() {
  assert.equal(r("one\ntwo"), "one<br>\ntwo");
  assert.equal(r("one\r\ntwo"), "one<br>\ntwo");
}

function testUnclosedAndStrayTagsAreLiteral() {
  assert.equal(r("[b]never closed"), "[b]never closed");
  assert.equal(r("stray[/i] close"), "stray[/i] close");
  assert.equal(r("[b]x [i]y[/b]"), "<strong>x [i]y</strong>");
  assert.equal(r("[b=1]attr on bold[/b]"), "[b=1]attr on bold[/b]");
}

function testCodeIsVerbatim() {
  assert.equal(r("[code]\n[b]not bold[/b] <x>\n[/code]"),
    "<pre><code>[b]not bold[/b] &lt;x&gt;</code></pre>");
  assert.equal(r("[code]http://example.com[/code]"),
    "<pre><code>http://example.com</code></pre>");
}

function testUrls() {
  assert.equal(r("[url]https://example.com/a?b=1&c=2[/url]"),
    `<a href="https://example.com/a?b=1&amp;c=2" rel="nofollow ugc noopener">https://example.com/a?b=1&amp;c=2</a>`);
  assert.equal(r("[url=https://example.com]the [b]site[/b][/url]"),
    `<a href="https://example.com" rel="nofollow ugc noopener">the <strong>site</strong></a>`);
  // Only http(s) is ever linked.
  assert.equal(r("[url=javascript:alert(1)]x[/url]"), "[url=javascript:alert(1)]x[/url]");
  assert.equal(r("[url]javascript:alert(1)[/url]"), "[url]javascript:alert(1)[/url]");
  // Attribute quoting can't break out of href.
  assert.ok(!r(`[url=https://e.com/"onmouseover="x]y[/url]`).includes(`"onmouseover`));
}

function testBareUrlsAreLinkedWithoutTrailingPunctuation() {
  assert.equal(r("see https://example.com/x."),
    `see <a href="https://example.com/x" rel="nofollow ugc noopener">https://example.com/x</a>.`);
  assert.equal(r("(https://en.wikipedia.org/wiki/Foo_(bar))"),
    `(<a href="https://en.wikipedia.org/wiki/Foo_(bar)" rel="nofollow ugc noopener">https://en.wikipedia.org/wiki/Foo_(bar)</a>)`);
  assert.equal(r("(see https://example.com)"),
    `(see <a href="https://example.com" rel="nofollow ugc noopener">https://example.com</a>)`);
}

function testQuotes() {
  assert.equal(r("[quote]plain[/quote]"), "<blockquote>plain</blockquote>");
  assert.equal(r(`[quote="W. Hale" post=12]\nhello\n[/quote]\nreply`),
    `<blockquote><cite><a href="/p/12">W. Hale wrote:</a></cite>hello</blockquote>reply`);
  assert.equal(r("[quote=dan]hi[/quote]"), "<blockquote><cite>dan wrote:</cite>hi</blockquote>");
  assert.equal(r(`[quote=<b>x</b>]hi[/quote]`),
    "<blockquote><cite>&lt;b&gt;x&lt;/b&gt; wrote:</cite>hi</blockquote>");
  assert.equal(r("[quote][quote]inner[/quote]outer[/quote]"),
    "<blockquote><blockquote>inner</blockquote>outer</blockquote>");
}

function testQuoteAttr() {
  assert.deepEqual(parseQuoteAttr(`"W. Hale" post=7`), { name: "W. Hale", postId: 7 });
  assert.deepEqual(parseQuoteAttr(`W. Hale post=7`), { name: "W. Hale", postId: 7 });
  assert.deepEqual(parseQuoteAttr(`dan`), { name: "dan", postId: null });
  assert.deepEqual(parseQuoteAttr(null), { name: null, postId: null });
}

function testQuoteForStripsNestedQuotes() {
  const body = `[quote=a]old [quote=b]older[/quote][/quote]\nmy point`;
  assert.equal(quoteFor("dan", 9, body), `[quote="dan" post=9]\nmy point\n[/quote]\n`);
}

function testDeepNestingIsBounded() {
  const deep = "[b]".repeat(100) + "x" + "[/b]".repeat(100);
  const html = r(deep);
  assert.ok((html.match(/<strong>/g) ?? []).length <= 25);
}

testHtmlIsAlwaysEscaped();
testSimpleTags();
testNewlinesBecomeBreaks();
testUnclosedAndStrayTagsAreLiteral();
testCodeIsVerbatim();
testUrls();
testBareUrlsAreLinkedWithoutTrailingPunctuation();
testQuotes();
testQuoteAttr();
testQuoteForStripsNestedQuotes();
testDeepNestingIsBounded();
console.log("bbcode: all tests passed");
