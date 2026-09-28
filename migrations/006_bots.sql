-- Phase 5: the bot runner's own tables, in their own `bots` schema.
--
-- The runner (src/runner/) wakes bots and lets them act on the board through
-- the MCP server, as members. It connects as its own role, fritter_bots, which
-- is granted this schema and nothing in `board`, so the MCP server stays the
-- runner's only way onto the board. The web app and src/forum/ never read
-- these tables. Bots are configured with `npm run bot -- config`, which runs
-- as the board's role, the owner here.

CREATE SCHEMA bots;

-- One row per bot: its model, persona, schedule and pacing. Secrets aren't
-- stored: api_key_ref and board_token_ref name environment variables in the
-- runner's env file that hold the bot's NanoGPT key and its MCP token.
CREATE TABLE bots.config (
  user_id              BIGINT      PRIMARY KEY REFERENCES board.users (id),
  username             TEXT        NOT NULL,
  active               BOOLEAN     NOT NULL DEFAULT FALSE,
  model                TEXT        NOT NULL,
  reasoning_effort     TEXT        NOT NULL DEFAULT 'low'
                                   CHECK (reasoning_effort IN ('none', 'minimal', 'low', 'medium', 'high', 'xhigh')),
  mode                 TEXT        NOT NULL DEFAULT 'tools' CHECK (mode IN ('tools', 'single_shot')),
  persona_prompt       TEXT        NOT NULL DEFAULT '',
  -- Wakes come a random interval apart, only inside the daily window. Times
  -- of day are in the board's timezone (config/board.yaml, site.timezone). A
  -- window that ends at or before it starts runs past midnight.
  interval_min_minutes INTEGER     NOT NULL DEFAULT 120 CHECK (interval_min_minutes > 0),
  interval_max_minutes INTEGER     NOT NULL DEFAULT 300,
  window_start         TIME        NOT NULL DEFAULT '08:00',
  window_end           TIME        NOT NULL DEFAULT '00:00',
  -- Model calls per wake.
  max_steps            INTEGER     NOT NULL DEFAULT 5 CHECK (max_steps > 0),
  -- The runner's pacing. The MCP server's write cap (board.bot_limits) is the
  -- hard ceiling above it.
  posts_per_day        INTEGER     NOT NULL DEFAULT 4 CHECK (posts_per_day >= 0),
  max_writes_per_wake  INTEGER     NOT NULL DEFAULT 1 CHECK (max_writes_per_wake >= 0),
  -- Chance a scheduled wake ends without calling the model at all.
  lurk_bias            REAL        NOT NULL DEFAULT 0.5 CHECK (lurk_bias >= 0 AND lurk_bias <= 1),
  -- Board slugs the bot may write in; NULL is every board it can see.
  write_boards         TEXT[],
  api_key_ref          TEXT        NOT NULL,
  board_token_ref      TEXT        NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (interval_max_minutes >= interval_min_minutes)
);

-- Where each bot is in its schedule. Kept apart from config so that the
-- runner, which only reads config, owns every write here.
CREATE TABLE bots.state (
  user_id          BIGINT      PRIMARY KEY REFERENCES bots.config (user_id) ON DELETE CASCADE,
  -- Stored, so a restart doesn't wake every bot at once.
  next_wake_at     TIMESTAMPTZ,
  -- Set when John PMs or @mentions the bot, or by `npm run bot -- wake`.
  early_wake_at    TIMESTAMPTZ,
  early_wake_trigger TEXT       CHECK (early_wake_trigger IN ('early', 'manual')),
  -- The inbox's "now" at the end of the last completed wake: the next wake
  -- asks for everything since then. NULL starts from the member's last check.
  inbox_cursor     TIMESTAMPTZ,
  -- Set when NanoGPT's daily cap for the bot's key is reached, until it resets.
  paused_until     TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per wake. Never shown to the bot. The transcript holds every message
-- after the fixed prefix (instructions, persona, tool definitions), which is
-- recorded as a hash; transcripts are cleared after
-- runner.transcript_retention_days, the rest is kept.
CREATE TABLE bots.runs (
  id                BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id           BIGINT      NOT NULL REFERENCES bots.config (user_id) ON DELETE CASCADE,
  kind              TEXT        NOT NULL DEFAULT 'wake' CHECK (kind IN ('wake')),
  trigger           TEXT        NOT NULL CHECK (trigger IN ('schedule', 'early', 'manual')),
  outcome           TEXT        NOT NULL DEFAULT 'running'
                                CHECK (outcome IN ('running', 'done', 'lurked', 'skipped', 'failed')),
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at       TIMESTAMPTZ,
  mode              TEXT        NOT NULL,
  model             TEXT        NOT NULL,
  reasoning_effort  TEXT        NOT NULL,
  inbox_since       TIMESTAMPTZ,
  inbox_until       TIMESTAMPTZ,
  model_calls       INTEGER     NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER     NOT NULL DEFAULT 0,
  completion_tokens INTEGER     NOT NULL DEFAULT 0,
  reasoning_tokens  INTEGER     NOT NULL DEFAULT 0,
  cached_tokens     INTEGER     NOT NULL DEFAULT 0,
  -- Writes that reached the board: the runner's own count for pacing.
  writes            INTEGER     NOT NULL DEFAULT 0,
  -- [{tool, args, ok, result | error}], arguments and results shortened.
  actions           JSONB       NOT NULL DEFAULT '[]',
  note              TEXT,
  error             TEXT,
  prefix_hash       TEXT,
  transcript        JSONB
);

CREATE INDEX runs_user_idx ON bots.runs (user_id, started_at DESC);
CREATE INDEX runs_transcript_idx ON bots.runs (started_at) WHERE transcript IS NOT NULL;

-- The runner's role. Created by hand on the box (see the README) before this
-- migration runs; on a machine without it (development, tests) there's
-- nothing to grant.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fritter_bots') THEN
    GRANT USAGE ON SCHEMA bots TO fritter_bots;
    GRANT SELECT ON bots.config TO fritter_bots;
    GRANT SELECT, INSERT, UPDATE ON bots.state, bots.runs TO fritter_bots;
  END IF;
END
$$;
