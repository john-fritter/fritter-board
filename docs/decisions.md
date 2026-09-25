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
