-- Phase 6: the bots' memory, and the admin's record of changes to them.
--
-- The runner writes notes and standing versions for each bot, and caches
-- thread summaries; the admin reads and edits them at /admin/bots. As in
-- migration 006, nothing here names a board table: the runner's role can't see
-- the board, so thread ids and member names are stored as plain values.

-- Short notes a bot writes to itself with `remember`. `about` is a member's
-- username, as the board spelled it when the note was written. Archived notes
-- have been folded into the bot's standing document by a compaction; they're
-- kept, and `recall` and the notes that come with a thread still find them.
CREATE TABLE bots.notes (
  id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       BIGINT      NOT NULL REFERENCES bots.config (user_id) ON DELETE CASCADE,
  body          TEXT        NOT NULL,
  about         TEXT,
  thread_id     BIGINT,
  run_id        BIGINT      REFERENCES bots.runs (id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at   TIMESTAMPTZ,
  search_vector TSVECTOR    GENERATED ALWAYS AS (to_tsvector('english', body || ' ' || COALESCE(about, ''))) STORED
);

CREATE INDEX notes_user_idx ON bots.notes (user_id, created_at DESC);
CREATE INDEX notes_about_idx ON bots.notes (user_id, LOWER(about)) WHERE about IS NOT NULL;
CREATE INDEX notes_search_idx ON bots.notes USING GIN (search_vector);

-- A bot's standing document: what it has come to think, in its own words.
-- Every version is kept; the newest is the current one. Compaction writes a
-- new version, and so does the admin, by editing or by restoring an old one.
CREATE TABLE bots.standing_versions (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT      NOT NULL REFERENCES bots.config (user_id) ON DELETE CASCADE,
  body       TEXT        NOT NULL,
  source     TEXT        NOT NULL CHECK (source IN ('compaction', 'admin', 'rollback')),
  -- The compaction run that wrote it, or the admin who did.
  run_id     BIGINT      REFERENCES bots.runs (id) ON DELETE SET NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX standing_versions_user_idx ON bots.standing_versions (user_id, id DESC);

-- Summaries of long threads' earlier posts, shared by every bot. The runner
-- hands one to a bot only after that bot's own read_thread of the thread has
-- succeeded, so the MCP server stays the permission check. A summary is
-- extended as the thread grows and rebuilt from scratch once it's old, so a
-- post removed since doesn't live on in it.
CREATE TABLE bots.thread_summaries (
  thread_id    BIGINT      PRIMARY KEY,
  -- The summary covers posts 1 to this one (post numbers, as read_thread gives them).
  through_post INTEGER     NOT NULL CHECK (through_post > 0),
  body         TEXT        NOT NULL,
  model        TEXT        NOT NULL,
  -- When it was built from the first post; updates extend it without resetting this.
  built_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Changes to a bot's settings and persona, from the admin pages or the CLI,
-- so a change can be seen and undone. `changes` is {column: {from, to}}.
CREATE TABLE bots.config_log (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT      NOT NULL REFERENCES bots.config (user_id) ON DELETE CASCADE,
  changed_by TEXT        NOT NULL,
  changes    JSONB       NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX config_log_user_idx ON bots.config_log (user_id, id DESC);

-- Compaction runs are logged with wakes. A wake's run also counts the calls
-- to the summary model it made, apart from the bot's own.
ALTER TABLE bots.runs DROP CONSTRAINT runs_kind_check;
ALTER TABLE bots.runs ADD CONSTRAINT runs_kind_check CHECK (kind IN ('wake', 'compaction'));
ALTER TABLE bots.runs
  ADD COLUMN summary_calls             INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN summary_prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN summary_completion_tokens INTEGER NOT NULL DEFAULT 0;

CREATE INDEX runs_compaction_idx ON bots.runs (user_id, started_at DESC) WHERE kind = 'compaction';

-- Set by the admin's "compact now"; the runner clears it once it has tried.
ALTER TABLE bots.state ADD COLUMN compact_requested_at TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fritter_bots') THEN
    GRANT SELECT, INSERT, UPDATE ON bots.notes, bots.thread_summaries TO fritter_bots;
    GRANT SELECT, INSERT ON bots.standing_versions TO fritter_bots;
  END IF;
END
$$;
