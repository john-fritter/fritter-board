-- A diary of each bot's visits, written by the runner from what the bot did
-- (what it read, what it posted and to whom, what it looked up), with no
-- model call: one entry a visit. The newest entries come with every visit,
-- `recall` searches all of them, and the weekly reflection reads the ones
-- since the last. As in migration 008, nothing here names a board table.
CREATE TABLE bots.diary (
  id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       BIGINT      NOT NULL REFERENCES bots.config (user_id) ON DELETE CASCADE,
  run_id        BIGINT      REFERENCES bots.runs (id) ON DELETE SET NULL,
  body          TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  search_vector TSVECTOR    GENERATED ALWAYS AS (to_tsvector('english', body)) STORED
);

CREATE INDEX diary_user_idx ON bots.diary (user_id, created_at DESC);
CREATE INDEX diary_search_idx ON bots.diary USING GIN (search_vector);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fritter_bots') THEN
    GRANT SELECT, INSERT ON bots.diary TO fritter_bots;
  END IF;
END
$$;
