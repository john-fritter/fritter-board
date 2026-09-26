# Decisions

Append-only. Why things are the way they are.

## 2026-09-25 — Stack: TypeScript, Hono, server-side JSX, plain SQL

The spec says to match Fritter Post's stack. Fritter Post is TypeScript on
Node 22 with `pg`, numbered SQL migrations, `tsx` scripts and `node:assert`
tests, so the board uses all of those, same conventions.

The one departure is the web framework. Fritter Post uses Next.js; the spec
asks for server-rendered HTML, minimal JavaScript and no SPA framework. Next.js
ships the React runtime to the browser even for server components, so the
board uses **Hono** with its built-in JSX, which renders to an HTML string on
the server and ships nothing. Pages send zero JavaScript; the CSP forbids
scripts outright (`default-src 'none'`). Same language, same component syntax,
one person can maintain both.

## 2026-09-25 — Markup: BBCode subset

The spec left Markdown vs BBCode open. BBCode: it's the 2006 idiom, its quote
syntax (`[quote="name" post=12]`) carries the link to the source post, and
unlike Markdown nothing in ordinary prose accidentally becomes markup
(asterisks, underscores in usernames, numbered lines).

The renderer escapes all text and only emits tags it writes itself, so there's
no separate sanitizer to get wrong. Unknown or malformed tags show literally.
`posts.body` keeps the source and `markup_version` records which renderer made
`body_html`, so a renderer change can re-render old posts.

## 2026-09-25 — Everything in the `board` schema, including migration tracking

The board may share Fritter Post's database. All board tables live in
`board`, and the migration log is `board._migrations`, not `_migrations`, which
Fritter Post already uses in `public`. The app connects with
`search_path=board`; migrations qualify names explicitly.

## 2026-09-25 — One PUBLIC_URL decides subdomain vs sub-path

`board.fritter.lol` vs `fritter.lol/board` is still open. `PUBLIC_URL` sets
both the origin (checked on form posts) and the base path (prefixed to every
link and the cookie path), so either works without code changes. For a
sub-path, the reverse proxy must pass the prefix through (Caddy `handle`, not
`handle_path`).

## 2026-09-25 — Forum logic lives in `src/forum/`, not in routes

Every permission check and write goes through `src/forum/`, which takes a
`Viewer` and knows nothing about HTTP. The MCP server (phase 4) will call the
same functions as the web routes, so bots and humans are held to identical
rules — "nothing in the forum code special-cases bots."

## 2026-09-25 — Security posture

- Sessions: random 256-bit token in an HttpOnly, SameSite=Lax cookie; only its
  SHA-256 is stored. Changing a password ends the member's other sessions.
- CSRF: form posts must carry an Origin matching `PUBLIC_URL`.
- Passwords: argon2id (`@node-rs/argon2`, prebuilt, works on Alpine).
- Login: failed attempts per username are capped in memory
  (`config/board.yaml`).
- Private board: invisible (404, not 403) to non-members, and filtered out of
  profile recent-posts and the index.
- Avatars use a fixed palette of CSS classes rather than inline styles, so the
  CSP needs no `unsafe-inline`.

## 2026-09-25 — Phase 2 rules of the house

Choices the spec left open, made while building the furniture:

- **Who edits:** authors edit their own posts (moderators too, in a locked
  thread); moderators don't rewrite other people's words — they remove, with a
  reason. Editing a thread's first post can fix its title. Edit history is
  visible to the author and moderators, not the public: it would otherwise
  preserve exactly what someone chose to retract.
- **Removed posts** keep their slot ("[removed by moderator]") so numbering and
  quote links stay stable. They leave search and profiles, and the author's
  post count drops (removed posts don't earn rank); board counts don't change.
  Only the admin can restore, per the spec's "John can reverse".
- **Standing:** suspended members can log in and read public boards but can't
  post, PM or see the Back Room; banning also ends every session. Only the
  admin changes standing.
- **PMs:** the admin can open any conversation (a banner says so on the
  admin's screen) but can't post into one they aren't part of, and reading as
  admin never marks messages read for the participants. Moderators have no
  PM access. Warnings arrive as a PM from the moderator, logged publicly.
- **Mod log:** fully public, except that any action whose target is (or was
  moved to or from) the members-only board is shown as "something in a
  members-only board", with no reason, to anyone who can't see that board.
- **New since last visit:** read markers per thread plus
  `users.marked_read_at` (join time, or "Mark all read"), so a new member
  doesn't start with the whole archive marked new.
- **Search:** Postgres full text with web-search syntax (`"phrase"`, `-word`,
  `or`); a thread-title match counts as a match on its first post; with only
  an author it lists that member's posts (the bots' own-history lookup).
  Excerpts come from `ts_headline`, which drops tag-like text; everything is
  escaped before `<mark>` is added.
- **RSS:** a board's newest threads, built as an anonymous visitor would see
  them. The Back Room has no feed at all, even for members, because feed
  readers carry no session.

## 2026-09-26 — Phase 3: the Fritter Post link

- **What an article id is.** `threads.fp_article_id` holds Fritter Post's
  `writer_pieces.id`. Its `paper_pieces.id` changes every time a morning is
  re-published, and its refs (`C27`) are per-run, so either would eventually
  attach a thread to the wrong article. A writer piece id survives a re-publish
  of the same run; if a paper is replaced from a different run, the old id
  stops resolving and the thread's card says the article is no longer in the
  paper. It can go missing; it can't turn into a different story.
- **How the board reads the paper.** Only through Fritter Post's `published`
  schema: two views (`articles`, `article_sources`) that Fritter Post owns and
  migrates (its 046). The board's role is granted that schema and nothing else,
  so it can't see Fritter Post's pipeline tables — above all `article_texts`,
  third-party text the paper never publishes and the bots would otherwise be
  able to send to NanoGPT. The connection is separate (`FP_DATABASE_URL`) and
  read-only at the session level too (`default_transaction_read_only`), so a
  mistake fails instead of writing. Nothing from the paper is copied into the
  board; cards read it live.
- **`/article/<id>` is the door.** Fritter Post's "Discuss on the board" link
  goes there. It redirects to the article's thread if the viewer can see one;
  otherwise it shows the card, and members get the new-thread form with the
  headline as the title. The paper only links; it never reads the board, so it
  shows no reply counts.
- **Where article threads start.** Always the board named in
  `fritter_post.discussion_board` (News), not a board the member picks. The
  spec allows one thread per article; a member choosing the Back Room would
  quietly give the article a discussion the public can never see or start.
  Moderators can still move one, deliberately and in the log.
- **The Back Room and the article page.** If an article's thread is in a
  members-only board, a visitor sees the card and "Log in to start or join the
  discussion" — worded to be true either way — and no redirect, link or count.
  A suspended member (who can't see the Back Room) gets the card and can't
  start a second thread around it. One thread per article is enforced by the
  unique index, now limited to undeleted threads, and a lost race joins the
  winner's thread.
- **When the paper is down,** a thread still renders; its card says the article
  couldn't be loaded. A board run without `FP_DATABASE_URL` has no article pages.
- **The dek** is the piece's first paragraph, cut at a word boundary
  (`dek_max_chars`), not its first sentence: Fritter Post learned the hard way
  that a period-plus-space ends "U.S." as readily as a clause. A section line
  (no headline) leads on its sentence and has no dek.

## 2026-09-26 — Deployed at board.fritter.lol

Gizmo deployed phases 1–3 from branch `claude/fritter-board-phase-three-wmh6tj`
(`cb84bd7`), together with Fritter Post's side of the link (`5fa8c8f`).

- **A subdomain, not `/board`.** The spec left it open. A subdomain keeps the
  board's cookies, CSP and Caddy block wholly separate from the paper's, and it
  needed nothing in either app: `PUBLIC_URL` already handled both forms.
- **Its own database role, not Fritter Post's.** `fritter_board` owns the
  `board` schema and can read Fritter Post's `published` views and nothing else.
  Checked on the box: `published.articles` reads and `article_texts` is refused.
- **The admin account was created with a random temporary password** kept
  root-only on the box, for John to change at Settings. That way no password
  passed through a relay or a report.
- **CSRF, restated.** The 2026-09-25 entry says form posts must carry a matching
  Origin. Precisely: Hono's `csrf` accepts a matching `Origin` **or**
  `Sec-Fetch-Site: same-origin`. That matters in production, because Caddy's
  site block sets `Referrer-Policy: no-referrer`, and under that policy
  browsers send `Origin: null` on same-origin form posts. Logins work on
  `Sec-Fetch-Site`, which was confirmed in Chromium. The app's own
  `same-origin` policy would keep both checks available. Removing Caddy's line
  is recommended, not required.
- **No backups.** The deploy found no Postgres dump for `fritter_post`, and the
  board now keeps what the pipeline can't regenerate: members, posts and PMs.
  The same gap is recorded in Fritter Post's `docs/open-items.md`.

Still to do by hand: John changes the temporary password, then posts
`docs/site-rules.md` as a sticky thread in Site Business.

