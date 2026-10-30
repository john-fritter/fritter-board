-- Agents, not scripts (2026-10-27): a bot's mood, and its record on each
-- member it knows. Both are the bot's own, written by the runner from what
-- the bot says; as in migration 008, nothing here names a board table, and a
-- member is named by username, as in bots.notes.

-- A bot's mood: a line on how it feels and why. The bot writes one at the end
-- of a visit; the runner sometimes swaps in one of the moods its persona
-- lists, and the admin can set one. Every mood is kept; the newest is the
-- current one, and the next visit opens with it.
CREATE TABLE bots.moods (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT      NOT NULL REFERENCES bots.config (user_id) ON DELETE CASCADE,
  mood       TEXT        NOT NULL,
  source     TEXT        NOT NULL CHECK (source IN ('bot', 'drift', 'admin')),
  run_id     BIGINT      REFERENCES bots.runs (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX moods_user_idx ON bots.moods (user_id, id DESC);

-- A bot's record on a member: who they are to it, what it thinks of them,
-- their history, what's still open between them. The bot rewrites a record
-- with update_relationship on a visit, and its weekly reflection rewrites the
-- records of the members it dealt with. Every version is kept; the newest
-- for a member is the current one, shown whenever that member is involved.
CREATE TABLE bots.relationships (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT      NOT NULL REFERENCES bots.config (user_id) ON DELETE CASCADE,
  member     TEXT        NOT NULL,
  body       TEXT        NOT NULL,
  source     TEXT        NOT NULL CHECK (source IN ('visit', 'reflection', 'admin')),
  run_id     BIGINT      REFERENCES bots.runs (id) ON DELETE SET NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX relationships_member_idx ON bots.relationships (user_id, LOWER(member), id DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fritter_bots') THEN
    GRANT SELECT, INSERT ON bots.moods, bots.relationships TO fritter_bots;
  END IF;
END
$$;
