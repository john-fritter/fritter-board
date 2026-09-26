import assert from "node:assert/strict";
import { insertUser } from "../src/forum/accounts.js";
import { createThread } from "../src/forum/threads.js";
import type { Viewer } from "../src/forum/types.js";
import { FP_ORIGIN, run, setup, threadIdFrom } from "./support.js";

// Phase 3 end to end: the Fritter Post link. Article pages, starting an
// article's thread, the card on the thread, one thread per article, and the
// Back Room staying hidden when an article's thread is moved into it.

const { pool, fp, forum, reset, req, login } = setup("phase3", { fp: true });

const PW = "a-long-password";

/**
 * Fixtures standing in for Fritter Post's `published` views (its migration
 * 046): tables with the same columns, read through the board's real
 * read-only pool.
 */
async function resetPaper(): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS published CASCADE");
  await pool.query("CREATE SCHEMA published");
  await pool.query(`
    CREATE TABLE published.articles (
      id BIGINT PRIMARY KEY, published_on DATE NOT NULL, ref TEXT NOT NULL,
      rank INT NOT NULL, section_rank INT NOT NULL DEFAULT 0, tier TEXT NOT NULL,
      section_ref TEXT, section_title TEXT, section_role TEXT, headline TEXT,
      body TEXT NOT NULL, word_count INT NOT NULL DEFAULT 0, source_count INT NOT NULL DEFAULT 0,
      published_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`
    CREATE TABLE published.article_sources (
      article_id BIGINT NOT NULL, position INT NOT NULL, source_name TEXT NOT NULL,
      title TEXT NOT NULL, url TEXT NOT NULL, published_at TIMESTAMPTZ)`);
  await pool.query(
    `INSERT INTO published.articles (id, published_on, ref, rank, tier, section_title, headline, body, word_count, source_count)
     VALUES (101, '2026-09-24', 'C3', 3, 'feature', NULL, 'Council approves the <b>bridge</b> plan',
             'The city council voted 7–2 on Tuesday to fund the bridge.' || E'\n\n' || 'Second paragraph.', 420, 6),
            (102, '2026-09-24', 'S9', 40, 'brief', 'Wildfire season', NULL,
             'Crews held the fire line overnight near Sisters.', 9, 1),
            (103, '2026-09-25', 'C1', 1, 'feature', NULL, 'Library hours extended', 'Starting in October.', 3, 2)`
  );
}

async function main() {
  await reset();
  await resetPaper();
  const ids = {
    john: await insertUser(pool, { username: "John", password: PW, role: "admin" }),
    mo: await insertUser(pool, { username: "Mo", password: PW, role: "moderator" }),
    dan: await insertUser(pool, { username: "Dan", password: PW }),
    eve: await insertUser(pool, { username: "Eve", password: PW }),
  };
  const [john, mo, dan, eve] = [await login("John", PW), await login("Mo", PW), await login("Dan", PW), await login("Eve", PW)];
  const eveViewer: Viewer = { id: ids.eve, username: "Eve", role: "member", status: "active", isBot: false };

  // ── The article page, before anyone has discussed it ──
  let res = await req("GET", "/article/999");
  assert.equal(res.status, 404, "an article the paper doesn't have");
  res = await req("GET", "/article/abc");
  assert.equal(res.status, 404);
  res = await req("GET", "/article/101");
  assert.equal(res.status, 200);
  assert.ok(res.text.includes("Council approves the &lt;b&gt;bridge&lt;/b&gt; plan"), "headlines are escaped");
  assert.ok(res.text.includes("The city council voted 7–2"), "the dek is the first paragraph");
  assert.ok(!res.text.includes("Second paragraph"));
  assert.ok(res.text.includes("Thursday, September 24, 2026"), "the edition date doesn't drift a day");
  assert.ok(res.text.includes(`href="${FP_ORIGIN}/article/101"`), "the card links to the paper's permanent page");
  assert.ok(res.text.includes("/login?next=%2Farticle%2F101"), "visitors are asked to log in");
  assert.ok(!res.text.includes('name="body"'), "visitors get no form");

  res = await req("GET", "/article/101", { cookie: dan });
  assert.equal(res.status, 200);
  assert.ok(res.text.includes("Start the discussion in News"));
  assert.ok(res.text.includes('value="Council approves the &lt;b&gt;bridge&lt;/b&gt; plan"'), "the title starts as the headline");

  // A section line has no headline: its sentence is the title, with no dek.
  res = await req("GET", "/article/102", { cookie: dan });
  assert.ok(res.text.includes('value="Crews held the fire line overnight near Sisters."'));
  assert.ok(res.text.includes("Part of Wildfire season"));

  // ── Starting the discussion ──
  res = await req("POST", "/article/101", { cookie: dan, form: { title: "The bridge", body: "", action: "post" } });
  assert.equal(res.status, 400, "the usual validation applies");
  res = await req("POST", "/article/101", { cookie: dan, form: { title: "The bridge", body: "[b]About time.[/b]", action: "preview" } });
  assert.ok(res.text.includes("<strong>About time.</strong>"), "preview works");
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM threads")).rows[0].n, 0, "preview saves nothing");
  res = await req("POST", "/article/101", { cookie: dan, form: { title: "The bridge", body: "About time.", action: "post" } });
  assert.equal(res.status, 303);
  const t1 = threadIdFrom(res.location);
  const row = (await pool.query("SELECT t.fp_article_id, t.board_id, b.slug FROM threads t JOIN boards b ON b.id = t.board_id WHERE t.id = $1", [t1])).rows[0];
  assert.equal(row.fp_article_id, 101);
  assert.equal(row.slug, "news", "article threads start in the configured board");
  assert.equal((await pool.query("SELECT thread_count FROM boards WHERE slug = 'news'")).rows[0].thread_count, 1, "counts kept");

  res = await req("GET", `/t/${t1}`);
  assert.equal(res.status, 200);
  assert.ok(res.text.includes('class="fp-card"'), "the thread shows the article card");
  assert.ok(res.text.includes(`${FP_ORIGIN}/article/101`));
  assert.ok(res.text.includes("6 sources"));

  // ── One thread per article ──
  for (const cookie of [null, eve]) {
    res = await req("GET", "/article/101", { cookie });
    assert.equal(res.status, 302, "the article page opens the existing thread");
    assert.equal(res.location, `/t/${t1}`);
  }
  res = await req("POST", "/article/101", { cookie: eve, form: { title: "Bridge again", body: "Me too.", action: "post" } });
  assert.equal(res.location, `/t/${t1}`, "a second start joins the first thread");
  await assert.rejects(
    createThread(forum, eveViewer, row.board_id, "Race", "Lost it.", { fpArticleId: 101 }),
    (err: { status?: number }) => err.status === 409,
    "the forum layer refuses a second thread for an article"
  );
  await assert.rejects(
    createThread(forum, eveViewer, row.board_id, "Nothing", "Nope.", { fpArticleId: 999 }),
    (err: { status?: number }) => err.status === 404,
    "and a thread for an article the paper doesn't have"
  );
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM threads")).rows[0].n, 1);

  // ── The Back Room doesn't leak through the article page ──
  res = await req("POST", `/t/${t1}/mod`, { cookie: mo, form: { action: "move", board: "back-room", reason: "private" } });
  assert.equal(res.status, 303);
  res = await req("GET", "/article/101");
  assert.equal(res.status, 200, "a visitor sees the article, not a redirect into the Back Room");
  assert.ok(!res.text.includes(`/t/${t1}`), "and no trace of the thread");
  assert.ok(res.text.includes("Log in"));
  res = await req("GET", "/article/101", { cookie: eve });
  assert.equal(res.location, `/t/${t1}`, "members still reach it");
  res = await req("POST", "/article/101", { cookie: eve, form: { title: "x", body: "y", action: "post" } });
  assert.equal(res.location, `/t/${t1}`);

  // Suspended members can't see the Back Room: no form, no redirect, no thread.
  await pool.query("UPDATE users SET status = 'suspended' WHERE id = $1", [ids.eve]);
  res = await req("GET", "/article/101", { cookie: eve });
  assert.equal(res.status, 200);
  assert.ok(!res.text.includes(`/t/${t1}`) && !res.text.includes('name="body"'));
  res = await req("POST", "/article/101", { cookie: eve, form: { title: "x", body: "y", action: "post" } });
  assert.equal(res.location, "/article/101", "and can't start a second thread around it");
  await pool.query("UPDATE users SET status = 'active' WHERE id = $1", [ids.eve]);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM threads")).rows[0].n, 1);

  // ── The paper is read-only from here ──
  await assert.rejects(fp!.query("INSERT INTO articles (id, published_on, ref, rank, tier, body) VALUES (1, NOW(), 'x', 1, 'brief', 'x')"), /read-only/);
  await assert.rejects(fp!.query("CREATE TABLE published.oops (id int)"), /read-only/);

  // ── When the paper changes or goes away, the thread carries on ──
  res = await req("POST", "/article/103", { cookie: john, form: { title: "Library hours", body: "Good news.", action: "post" } });
  const t2 = threadIdFrom(res.location);
  await pool.query("DELETE FROM published.articles WHERE id = 103");
  res = await req("GET", `/t/${t2}`);
  assert.equal(res.status, 200);
  assert.ok(res.text.includes("This article is no longer in the paper."));
  assert.equal((await req("GET", "/article/103")).status, 404);

  await pool.query("DROP SCHEMA published CASCADE");
  const logged = console.error;
  console.error = () => {};
  try {
    res = await req("GET", `/t/${t2}`);
  } finally {
    console.error = logged;
  }
  assert.equal(res.status, 200, "a thread renders even when the paper can't be read");
  assert.ok(res.text.includes("couldn&#39;t be loaded") && res.text.includes("Good news."));

  // A board without the paper: no article pages, threads still fine.
  const bare = setup("phase3-bare");
  try {
    res = await bare.req("GET", "/article/101");
    assert.equal(res.status, 404);
    res = await bare.req("GET", `/t/${t2}`);
    assert.equal(res.status, 200);
    assert.ok(res.text.includes("couldn&#39;t be loaded"), "the thread says it's about an article it can't show");
  } finally {
    await bare.pool.end();
  }
}

run("phase3", pool, main, fp);
