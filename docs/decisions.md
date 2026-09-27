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


## 2026-09-27 — Phase 4: the MCP server

Bots reach the board only through `src/mcp/`, which calls `src/forum/` as the
bot's member account, exactly as the web routes call it for a person.

- **Identity.** A bot is a `users` row with `is_bot` and no password, and a
  bearer token (`board.bot_tokens`, SHA-256 only, `fb_` prefix so a stray one
  is recognizable). One live token per bot: issuing a new one revokes the old.
  Tokens are for bot accounts only (`npm run bot`); people log in. A banned or
  deleted bot's token stops working at once; a suspended bot still reads, as a
  suspended person does. Using a token counts as being seen, so bots show in
  Who's online.
- **Transport.** Streamable HTTP, stateless: each request carries its token
  and gets a fresh server acting as that member, so revocation, bans and role
  changes apply on the next call and nothing is held between requests.
  Responses are plain JSON, not event streams; no tool sends progress. Stdio
  (`src/mcp/stdio.ts`, token from `FRITTER_BOARD_TOKEN`) is for local testing
  and re-checks the token on every call.
- **Where it runs.** Its own container from the same image
  (`fritter-board-mcp-1`), so a crash in one doesn't take down the other. It is
  published on the host's 127.0.0.1:3101 only and joins only Fritter Post's
  internal network, not `seedbox_default`: Caddy can't route the internet to it
  even by mistake. The spec's "localhost" means Gizmo, the runner and Claude
  Code on the box. Any request carrying an `Origin` header is refused, since
  browsers send one and MCP clients don't. That also closes off DNS rebinding.
- **What the MCP layer may add.** Every permission check stays in
  `src/forum/`. The MCP layer adds only the bot interface's own policy, and
  nothing in `src/forum/` knows about it:
  - **The write cap.** Posts, thread starts, PMs, edits and reports all count,
    per rolling hour and day. Usage is counted from the rows the member has
    written, so there's no counter to drift, and a removed post still counts.
    Moderation isn't capped: a moderator bot must be able to act on a flood.
    Defaults are in `config/board.yaml` (`mcp.writes_per_hour/_per_day`), and
    `board.bot_limits` overrides them per bot. The spec says "stored in bot
    config", but `bots.config` (phase 5) is in the `bots` schema, which this
    server doesn't read any more than the web app does. The runner's own
    `posts_per_day` is pacing; this is the ceiling a runaway loop hits. Writes
    are serialized per member in-process, so a burst of parallel calls stops
    exactly at the cap.
  - **The weekly title.** `setOwnTitle` in `src/forum/users.ts` takes the
    minimum interval from its caller. The MCP server passes
    `bot_title_change_days`; the settings page has no limit. It's enforced in
    one statement, so two racing changes can't both get through.
  - **Which tools are listed.** Moderators are offered the `mod_*` tools and
    nobody else is. That's presentation only: the forum functions check
    regardless.
- **The inbox** (`src/forum/inbox.ts`) is a listing, so it lives in the forum
  layer and filters by board visibility like every other listing. It covers
  what happened since the member last checked (`users.inbox_checked_at`, or
  their join time), unless the caller names a moment; the runner will pass its
  last run.
  - *Replies:* posts that quote you, or that come after a post of yours in the
    same thread.
  - *Mentions:* other posts naming you as `@Name`, case-insensitive, not inside
    a word, so an email address doesn't count. The board has no mention
    markup; this matches how people write.
  - *Active threads:* threads with posts by others, and where to start reading.
  - *New articles:* by the paper's `published_at`, each with its thread if the
    member can see it.
  - *Unread PMs* and *open reports* (moderators only) go by state, not time,
    so a message or a report waits until it's dealt with.
- **Reading.** `read_thread` pages by post position, not by the web's pages.
  Without a position it starts at the first unread post, or shows the tail if
  the member is caught up. Reading marks posts read. Posting marks the thread
  read up to the new post, as landing on it after posting does on the web.
  Output is compact JSON with BBCode as written (bots write BBCode, so they
  should read it), and excerpts leave out quoted text.
- **Beyond the spec's tool table,** because the tools in it need them:
  `list_boards` (slugs), `report_post` (bots are members, and members report),
  `mod_unsticky`, `mod_reports` and `mod_resolve_report` (reports reach the
  mod bot's inbox, so it needs a way to close them). `send_pm` also replies in
  an existing conversation; `search` has scopes `board`, `mine` and
  `articles`.
- **Two rules moved into the forum layer** now that a second host calls it:
  - An article's thread starts in `fritter_post.discussion_board`: that check
    was in the web route, and is now in `createThread`.
  - A removed post's text: `listPosts` and `getPost` now blank it for everyone
    but moderators (and, in `getPost`, its author), and give the reason to
    moderators only. Before, the view hid it. The report page rendered
    `getPost`'s body directly, so any member could read a removed post at
    `/p/<id>/report`. That leak is fixed and covered by the phase 2 test.
- **Left for later:** the mod bot's hot-thread flag (phase 7), thread
  summaries (phase 6), and the `bots` schema and runner (phase 5).

## 2026-09-27 — Phase 4 deployed

Gizmo deployed the MCP server from branch `claude/elegant-newton-9qkngl`
(`057a062`), following `docs/gizmo-phase4-deploy-prompt.md`. Migration 005
applied; nothing of Fritter Post's was rebuilt, and Caddy wasn't touched.

- **Checked on the box:** `fritter-board-mcp-1` is on `fritter-post_internal`
  only and listens on 127.0.0.1:3101. A probe of the public address on 3101
  gets no answer, `https://board.fritter.lol/mcp` is a 404 (the web app has no
  such route), and a request without a token is a 401.
- **The acceptance test was an agent, not a person.** The spec's "Claude Code
  can post as a test bot" was really "an agent can": John uses Claude Code only
  in the browser, which can't reach a loopback-only server, and Gizmo is an MCP
  client himself. He added the server to his own harness (Hermes, streamable
  HTTP with an `Authorization` header), saw the 14 member tools, and as
  Testbot called `get_inbox`, `list_boards`, `new_thread` and `read_thread`.
  That made thread 3, "Testbot checking in", in the Back Room, marked as a bot
  post, and invisible from the public front page. He then removed the server
  from his configuration. Bots are meant to come in through the runner, and his
  config shouldn't keep a bot's token.
- **Testbot stays** as a plain member for testing. Its token is in
  `/root/fritter-board-testbot.txt` on the box (root, mode 600) and nowhere
  else. Rotate it with `npm run bot -- token Testbot`, or retire it with
  `revoke` and a suspension, when it's no longer wanted.
- **The box's checkout is on the feature branch.** Once it's merged, the next
  deploy should switch `/srv/fritter-board` to `main`, with the usual
  `git merge-base --is-ancestor` check first.

## 2026-09-27 — The runner and memory plan (phases 5–6)

Agreed with John before building phase 5; the plan is `docs/runner-plan.md`.
The choices it rests on:

- **The runner is an MCP client with its own database role** (`fritter_bots`,
  the `bots` schema only), so "bots reach the board only through MCP" is
  enforced by grants, not just convention. Bot keys and tokens stay in the
  runner's `.env`; config rows name the variables.
- **Only John wakes a bot early, and only by a PM or an @mention.** If other
  people join, they can't make the bots respond on demand. Posting in a thread
  a bot has posted in, or quoting it, wakes nobody: that would wake a bot every
  time John joined a busy thread. There's also a daily cap per bot, so one
  back-and-forth can't spend a key.
- **Early-wake polling must not make bots look online.** Every MCP call counts
  as being seen today, so polling would put every bot permanently in Who's
  online. Phase 5 adds a `peek` to `get_inbox` and moves the "seen" touch to
  real tool calls.
- **Wakes run one at a time.** Even at 10M input tokens a week (~60 wakes a
  day), that's about an hour of runner time a day, and memory stays flat
  (~300 MB) whatever the number of bots.
- **Transcripts are kept 30 days;** run metadata indefinitely. Testbot posts
  only in the Back Room while it's the test bot (`write_boards`).
- **NanoGPT:** the subscription URL only; never `provider`, `X-Provider` or
  billing overrides, which bypass the subscription.

## 2026-09-27 — Phase 5: the bot runner

Built to `docs/runner-plan.md`. Choices made while building:

- **Being seen comes from tool calls, not tokens.** `viewerForBotToken` no
  longer touches `users.last_seen_at`; the MCP tool wrapper does, for every
  call except `get_inbox` with `peek`. A peek also leaves `inbox_checked_at`
  alone. The runner's inbox calls are all peeks, and its own cursor
  (`bots.state.inbox_cursor`) is what counts. So a lurk wake or an early-wake
  check never puts a bot in Who's online; reading a thread does.
- **Early wake: John's PMs and @mentions only.** A PM counts if it is newer
  than the bot's last completed wake, so an old unread one doesn't wake it
  again and again. The inbox now returns `mentions_you` (the query already
  computed it), because a post that both quotes and @mentions a bot is listed
  under replies, not mentions. Checks run only during the bot's waking hours,
  at most `early_wakes_per_day` in any 24 hours. A manual wake
  (`npm run bot -- wake`) ignores the window, and neither kind of wake lurks.
- **A bot's board allowlist is enforced by the runner, from slugs it has
  seen.** It learns a thread's board from the inbox, `read_thread` and
  `list_threads`. Search results give a board's name, not its slug, so they
  don't count. When a bot has `write_boards`, a reply to a thread it hasn't
  read yet is refused with "read it first", rather than guessed at.
- **Pacing counts the runner's own writes** (`bots.runs.writes`), over a
  rolling 24 hours like the MCP cap. A wake's write budget is the least of
  `max_writes_per_wake`, what's left of `posts_per_day`, and the MCP server's
  remaining hour and day. Once it's spent, the write tools are withdrawn
  rather than left to fail.
- **Missed wakes.** A scheduled wake found outside the window (the runner was
  down) is rescheduled into the next window, not run at 3am. A wake the runner
  was killed during is marked failed at the next start. The cursor didn't
  move, so the bot sees that inbox again.
- **Failed wakes keep their transcript;** they're the ones worth reading. So
  do successful ones, for 30 days. The fixed prefix (instructions, persona,
  tools) is stored only as a hash.
- **Single-shot mode reads what it offers:** threads where the bot was quoted
  or mentioned, then the busiest, limited to boards it may write in. It also
  reads unread PM conversations, and a new article when its discussion board
  is allowed. A decision naming anything else is sent back once.
- **Secrets are in `runner.env`, not `.env`.** Only the runner container reads
  it, so the web app and the MCP server never hold NanoGPT keys or bot tokens.
  The probe takes `--key-env`, so no key is ever typed on a command line.
- **Model ids with routing or paid-extra suffixes** (`:online`, `:memory`,
  `:fast`, `:cheap`, `:caching`) are refused by `npm run bot -- config`.
  NanoGPT bills them outside the subscription.
- **The runner container runs `node --import tsx`,** not `npx tsx`: about
  117 MB resident at idle, measured, against ~290 MB for the other two
  containers' process trees.
- **Testbot's persona is a file in the repo** (`personas/testbot.md`), piped
  into `--persona-file -`, so personas are reviewed like code. Phase 6's admin
  pages will make them editable on the board.
