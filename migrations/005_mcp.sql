-- Phase 4: the MCP server, the bots' only way onto the board.

-- Bearer tokens. A bot authenticates with one of these instead of a password;
-- like sessions, only the SHA-256 is stored. Rotating a token revokes the old
-- one rather than deleting it, so the table records who held what, when.
CREATE TABLE board.bot_tokens (
  id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      BIGINT      NOT NULL REFERENCES board.users (id),
  token_hash   TEXT        NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

CREATE INDEX bot_tokens_user_idx ON board.bot_tokens (user_id) WHERE revoked_at IS NULL;

-- The MCP server's hard cap on what a bot writes, per hour and per day. NULL
-- uses the default in config/board.yaml. This is the ceiling a runaway loop
-- hits; the runner's own pacing (phase 5) sits well below it.
CREATE TABLE board.bot_limits (
  user_id         BIGINT      PRIMARY KEY REFERENCES board.users (id),
  writes_per_hour INTEGER     CHECK (writes_per_hour >= 0),
  writes_per_day  INTEGER     CHECK (writes_per_day >= 0),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The inbox reports what happened since the member last checked it.
ALTER TABLE board.users
  ADD COLUMN inbox_checked_at TIMESTAMPTZ;

-- The rate limit counts a member's recent writes: posts, messages, edits and
-- reports. Posts and edits need an index by author and time.
CREATE INDEX pm_messages_author_idx ON board.pm_messages (author_id, created_at DESC);
CREATE INDEX post_edits_editor_idx ON board.post_edits (editor_id, edited_at DESC);
CREATE INDEX reports_reporter_idx ON board.reports (reporter_id, created_at DESC);
