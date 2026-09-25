-- The board's core schema. Everything lives in `board`, so the board can share
-- a database with Fritter Post without touching its tables. Bot-only tables
-- (config, memory, run log) belong in a separate `bots` schema, added later;
-- the forum app never reads them.
--
-- Room-to-grow rules from the spec: bigint ids, timestamptz everywhere, soft
-- deletes, no hard-coded board ids.

CREATE SCHEMA IF NOT EXISTS board;

-- ── Members ────────────────────────────────────────────────────────────────
-- One table for humans and bots. Nothing in the forum special-cases is_bot
-- beyond showing a badge.

CREATE TABLE board.users (
  id               BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username         TEXT        NOT NULL,
  password_hash    TEXT,                                   -- NULL for bots: they authenticate by token
  is_bot           BOOLEAN     NOT NULL DEFAULT FALSE,
  role             TEXT        NOT NULL DEFAULT 'member'
                   CHECK (role IN ('member', 'moderator', 'admin')),
  status           TEXT        NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'suspended', 'banned')),
  title            TEXT,                                   -- custom title; NULL falls back to rank
  title_changed_at TIMESTAMPTZ,
  avatar_override  TEXT,                                   -- reserved for an admin-set override
  bio              TEXT        NOT NULL DEFAULT '',
  joined_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at     TIMESTAMPTZ,
  post_count       INTEGER     NOT NULL DEFAULT 0,         -- denormalized, updated with each post
  deleted_at       TIMESTAMPTZ
);

-- Usernames are unique regardless of case: "Hale" and "hale" are one person.
CREATE UNIQUE INDEX users_username_lower_idx ON board.users (LOWER(username));
CREATE INDEX users_last_seen_idx ON board.users (last_seen_at DESC);

CREATE TABLE board.sessions (
  id           TEXT        PRIMARY KEY,                    -- sha256 of the cookie token, never the token
  user_id      BIGINT      NOT NULL REFERENCES board.users (id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX sessions_user_idx ON board.sessions (user_id);

CREATE TABLE board.invites (
  code       TEXT        PRIMARY KEY,
  created_by BIGINT      NOT NULL REFERENCES board.users (id),
  note       TEXT        NOT NULL DEFAULT '',               -- who it was for
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,                                   -- NULL: never expires
  used_by    BIGINT      REFERENCES board.users (id),
  used_at    TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ                                    -- revoked
);

CREATE TABLE board.ranks (
  min_posts INTEGER PRIMARY KEY CHECK (min_posts >= 0),
  title     TEXT    NOT NULL
);

-- ── Structure ──────────────────────────────────────────────────────────────

CREATE TABLE board.categories (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       TEXT        NOT NULL,
  sort_order INTEGER     NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE board.boards (
  id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category_id  BIGINT      NOT NULL REFERENCES board.categories (id),
  slug         TEXT        NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name         TEXT        NOT NULL,
  description  TEXT        NOT NULL DEFAULT '',
  members_only BOOLEAN     NOT NULL DEFAULT FALSE,
  sort_order   INTEGER     NOT NULL DEFAULT 0,
  thread_count INTEGER     NOT NULL DEFAULT 0,             -- denormalized
  post_count   INTEGER     NOT NULL DEFAULT 0,             -- denormalized
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at   TIMESTAMPTZ
);

CREATE TABLE board.threads (
  id             BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  board_id       BIGINT      NOT NULL REFERENCES board.boards (id),
  author_id      BIGINT      NOT NULL REFERENCES board.users (id),
  title          TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  first_post_id  BIGINT,                                   -- FK added below (circular)
  last_post_id   BIGINT,
  last_post_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reply_count    INTEGER     NOT NULL DEFAULT 0,           -- posts after the first, removed ones included
  sticky         BOOLEAN     NOT NULL DEFAULT FALSE,
  locked         BOOLEAN     NOT NULL DEFAULT FALSE,
  deleted_at     TIMESTAMPTZ,
  fp_article_id  BIGINT,                                   -- Fritter Post article, if any
  search_vector  TSVECTOR    GENERATED ALWAYS AS (to_tsvector('english', title)) STORED
);

-- Board pages list stickies first, then by last reply.
CREATE INDEX threads_board_order_idx
  ON board.threads (board_id, sticky DESC, last_post_at DESC)
  WHERE deleted_at IS NULL;
-- The index page's "last post" column: newest thread activity per board.
CREATE INDEX threads_board_last_post_idx
  ON board.threads (board_id, last_post_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX threads_search_idx ON board.threads USING GIN (search_vector);
-- One discussion thread per Fritter Post article at most.
CREATE UNIQUE INDEX threads_fp_article_idx
  ON board.threads (fp_article_id)
  WHERE fp_article_id IS NOT NULL;

CREATE TABLE board.posts (
  id             BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  thread_id      BIGINT      NOT NULL REFERENCES board.threads (id),
  author_id      BIGINT      NOT NULL REFERENCES board.users (id),
  body           TEXT        NOT NULL,                     -- markup as written
  body_html      TEXT        NOT NULL,                     -- rendered and sanitized
  markup_version SMALLINT    NOT NULL DEFAULT 1,           -- lets a renderer change re-render old posts
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at      TIMESTAMPTZ,
  edited_by      BIGINT      REFERENCES board.users (id),
  deleted_at     TIMESTAMPTZ,
  deleted_by     BIGINT      REFERENCES board.users (id),
  delete_reason  TEXT,
  search_vector  TSVECTOR    GENERATED ALWAYS AS (to_tsvector('english', body)) STORED
);

CREATE INDEX posts_thread_idx ON board.posts (thread_id, id);
CREATE INDEX posts_author_idx ON board.posts (author_id, id DESC);
CREATE INDEX posts_search_idx ON board.posts USING GIN (search_vector);

ALTER TABLE board.threads
  ADD CONSTRAINT threads_first_post_fk FOREIGN KEY (first_post_id) REFERENCES board.posts (id),
  ADD CONSTRAINT threads_last_post_fk  FOREIGN KEY (last_post_id)  REFERENCES board.posts (id);

CREATE TABLE board.post_edits (
  id        BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id   BIGINT      NOT NULL REFERENCES board.posts (id),
  editor_id BIGINT      NOT NULL REFERENCES board.users (id),
  old_body  TEXT        NOT NULL,
  edited_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX post_edits_post_idx ON board.post_edits (post_id, id);

-- ── Private messages ───────────────────────────────────────────────────────
-- One-to-one in v1; the participants table keeps group PMs possible later.

CREATE TABLE board.pm_conversations (
  id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject         TEXT        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE board.pm_messages (
  id              BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id BIGINT      NOT NULL REFERENCES board.pm_conversations (id),
  author_id       BIGINT      NOT NULL REFERENCES board.users (id),
  body            TEXT        NOT NULL,
  body_html       TEXT        NOT NULL,
  markup_version  SMALLINT    NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);

CREATE INDEX pm_messages_conversation_idx ON board.pm_messages (conversation_id, id);

CREATE TABLE board.pm_participants (
  conversation_id      BIGINT      NOT NULL REFERENCES board.pm_conversations (id),
  user_id              BIGINT      NOT NULL REFERENCES board.users (id),
  last_read_message_id BIGINT      REFERENCES board.pm_messages (id),
  joined_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at           TIMESTAMPTZ,                        -- left / archived by this participant
  PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX pm_participants_user_idx ON board.pm_participants (user_id);

-- ── Reading and moderation ─────────────────────────────────────────────────

CREATE TABLE board.read_markers (
  user_id           BIGINT      NOT NULL REFERENCES board.users (id),
  thread_id         BIGINT      NOT NULL REFERENCES board.threads (id),
  last_read_post_id BIGINT      NOT NULL REFERENCES board.posts (id),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, thread_id)
);

CREATE TABLE board.mod_actions (
  id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  moderator_id BIGINT      NOT NULL REFERENCES board.users (id),
  action       TEXT        NOT NULL,                       -- lock, unlock, move, sticky, remove_post, warn, …
  target_type  TEXT        NOT NULL,                       -- thread, post, user
  target_id    BIGINT      NOT NULL,
  reason       TEXT        NOT NULL DEFAULT '',
  details      JSONB       NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX mod_actions_created_idx ON board.mod_actions (created_at DESC);
