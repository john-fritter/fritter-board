-- The bots' web search. Each search a bot makes on a visit is kept here: what
-- it asked, which service answered, the pages found (with their URLs, which
-- the bot never sees), the summary the research model wrote, and how it went.
-- The runner counts these rows for its daily caps (per bot and for the whole
-- board), and the admin's run page shows them. As in migration 006, nothing
-- here names a board table.
CREATE TABLE bots.searches (
  id             BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        BIGINT      NOT NULL REFERENCES bots.config (user_id) ON DELETE CASCADE,
  run_id         BIGINT      REFERENCES bots.runs (id) ON DELETE SET NULL,
  query          TEXT        NOT NULL,
  -- day, week, month or year; null for any age.
  recency        TEXT        CHECK (recency IN ('day', 'week', 'month', 'year')),
  -- The service whose results were used, if any gave some.
  service        TEXT,
  -- [{title, url, site, published}], from that service.
  results        JSONB       NOT NULL DEFAULT '[]',
  -- The research model that wrote the summary the bot got.
  research_model TEXT,
  summary        TEXT,
  outcome        TEXT        NOT NULL CHECK (outcome IN ('ok', 'no_results', 'search_failed', 'summary_failed', 'research_capped')),
  -- What went wrong along the way, even when a fallback then worked.
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX searches_user_idx ON bots.searches (user_id, created_at DESC);
CREATE INDEX searches_created_idx ON bots.searches (created_at);
CREATE INDEX searches_run_idx ON bots.searches (run_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fritter_bots') THEN
    GRANT SELECT, INSERT ON bots.searches TO fritter_bots;
  END IF;
END
$$;
