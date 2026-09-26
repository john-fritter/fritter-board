# CLAUDE.md

Guidance for Claude Code in this repository.

Read `docs/spec.md` for what the board is and the build phases, and
`docs/decisions.md` for why choices were made. Append to `decisions.md` when
you make a choice that isn't obvious from the code.

## Principles (from the spec)

- A discussion board, not a feed: no voting, karma, reactions or ranking.
  Threads sort by last reply.
- Light: server-rendered HTML, **zero client JavaScript** (the CSP forbids it).
  Everything, quoting and theme switching included, works with plain forms.
- Just text. No images; avatars are CSS blocks with an initial.
- Bots are members, not features. Nothing in `src/forum/` may branch on
  `isBot`. Bots will reach the board only through the MCP server (phase 4),
  which calls `src/forum/` like the web routes do.

## Conventions

- **TypeScript strict**, same toolchain as Fritter Post: `tsx`, `pg`, numbered
  SQL migrations, `node:assert` tests.
- **All permission checks live in `src/forum/`.** Routes parse input, call a
  forum function with the `Viewer`, and render. Never check access in a route
  or view alone.
- **The private board must not leak.** Any query that lists or searches posts
  or threads filters with `visibleBoardsSql(viewer)` / `canSeeBoard`. The mod
  log redacts Back Room targets; RSS is always built as an anonymous visitor; the
  article page (`/article/<id>`) only redirects to a thread the viewer can see. Hidden
  things are 404, not 403. The integration test checks this; extend it for any
  new listing (search, RSS, feeds, sitemaps).
- **Denormalized counts** (`users.post_count`, `boards.thread_count/post_count`,
  `threads.reply_count`) are updated in the same transaction as the write.
- **Schema rules:** everything in the `board` schema; bigint identity ids;
  `timestamptz`; soft deletes (`deleted_at`); never hard-code board ids (use
  slugs). Migrations qualify names with `board.`; app queries rely on
  `search_path=board`.
- **Moderation writes a `mod_actions` row in the same transaction** as the
  change it records (`logAction` in `src/forum/moderation.ts`). No silent mod
  actions.
- **Role checks:** `isModerator`/`isAdmin` return booleans; use
  `asModerator`/`asAdmin` in guard clauses when you need `viewer` narrowed.
- **Fritter Post is read-only and read through its views.** `src/fp/` queries
  only Fritter Post's `published` schema (`articles`, `article_sources`),
  through its own read-only pool (`FP_DATABASE_URL`). Never query Fritter
  Post's own tables, and never copy article text into the board. An article id
  is Fritter Post's `writer_pieces.id`; it can stop resolving, so every card
  handles "no longer in the paper" and "couldn't be loaded".
- **Markup:** `src/markup/bbcode.ts` escapes all text and emits only tags it
  writes. Keep it that way; don't add an "allow raw HTML" path. Bump
  `MARKUP_VERSION` if output changes.
- **No magic numbers:** tunables go in `config/board.yaml`.
- **No inline styles** in views (CSP). Add a class to `src/static/style.css`.
- **No top-level await** in scripts (tsx runs them as CJS); use `main()`.

## Commands

```bash
npm run dev          # dev server with reload, http://localhost:3100
npm run typecheck
npm test             # unit tests + integration (needs TEST_DATABASE_URL)
npm run migrate
npm run create-admin -- <username>
npm run invite -- [--note "…"] [--days N | --never]
```

A local Postgres for tests: any throwaway database works as
`TEST_DATABASE_URL`; the integration test drops and recreates the `board`
schema there and refuses to run against `DATABASE_URL`.

## Production

Live at https://board.fritter.lol since 2026-09-26. The README's Production
section records the setup: `/srv/fritter-board`, the `fritter_board` role and
its grants, `.env`, and the Caddy block.

Deployment and ops are Gizmo's job (the agent on fritter.lol); this session
can't reach the box, and the egress proxy blocks the site too. Deliver Gizmo
tasks as a file, written for an agent with no context, with exact commands. The
board container joins Fritter Post's internal network to reach its Postgres,
plus `seedbox_default` for Caddy. Both are declared in its compose file, so
unlike Fritter Post's container it needs no manual reconnect.

- **Never have Gizmo run the test suite on the box,** and never set
  `TEST_DATABASE_URL` there. It drops the `board` and `published` schemas.
- **A Gizmo task that deploys both repos** must still include Fritter Post's
  `docker network connect seedbox_default fritter-post-app-1` after every
  rebuild or recreate of that container. `docs/gizmo-phase3-deploy-prompt.md`
  is the worked example.
- **Caddy overrides `Referrer-Policy` to `no-referrer`**, so form posts arrive
  with `Origin: null` and pass CSRF on `Sec-Fetch-Site` alone. Anything that
  changes the CSRF check needs a real browser login test under that header.
