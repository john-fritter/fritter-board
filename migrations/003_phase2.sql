-- Phase 2: the furniture. Most tables already exist (001); this adds what the
-- features need beyond them.

-- "New since last visit": a thread is unread for a member when it has a post
-- newer than both their read marker for it and this timestamp. New members
-- start with everything read; "Mark all read" moves it forward.
ALTER TABLE board.users
  ADD COLUMN marked_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Members report posts; reports queue for moderators (and later the mod bot's
-- inbox) until someone resolves them.
CREATE TABLE board.reports (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id     BIGINT      NOT NULL REFERENCES board.posts (id),
  reporter_id BIGINT      NOT NULL REFERENCES board.users (id),
  reason      TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by BIGINT      REFERENCES board.users (id),
  resolution  TEXT
);

CREATE INDEX reports_open_idx ON board.reports (created_at) WHERE resolved_at IS NULL;

-- Inbox: a member's conversations, newest activity first.
CREATE INDEX pm_conversations_last_idx ON board.pm_conversations (last_message_at DESC);

-- RSS: a board's newest threads.
CREATE INDEX threads_board_created_idx
  ON board.threads (board_id, created_at DESC)
  WHERE deleted_at IS NULL;
