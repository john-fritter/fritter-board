-- Phase 7: the moderator. The site rules become a thread the board knows
-- about; moderators get hot threads and a member's mod history; and the runner
-- gets moderation cycles, a second key for them, and the role briefs every
-- bot's prompt is built from.

-- ── The board ──────────────────────────────────────────────────────────────

-- The site rules: one public thread, marked by the admin, whose opening post
-- the moderator moderates against. /rules and the MCP tool read_rules find it.
ALTER TABLE board.threads ADD COLUMN is_rules BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX threads_one_rules_idx ON board.threads ((TRUE)) WHERE is_rules;

-- The rules were already posted by hand, as a "Site Rules" thread in Site
-- Business. Mark it, if it's there; otherwise the admin marks one later.
UPDATE board.threads SET is_rules = TRUE
 WHERE id = (
   SELECT t.id FROM board.threads t JOIN board.boards b ON b.id = t.board_id
    WHERE b.slug = 'site-business' AND NOT b.members_only
      AND t.deleted_at IS NULL AND LOWER(t.title) = 'site rules'
    ORDER BY t.id LIMIT 1);

-- Hot threads: posts in the last few minutes, across the board.
CREATE INDEX posts_created_idx ON board.posts (created_at);

-- A member's moderation history: the actions on them and on their posts.
CREATE INDEX mod_actions_target_idx ON board.mod_actions (target_type, target_id);

-- ── The runner ─────────────────────────────────────────────────────────────

-- Moderation cycles, for a bot that moderates: their own key (NanoGPT's cap
-- on it is separate from the member key's), reasoning effort and step limit.
-- The model is the bot's own. model_calls_per_day is the bot's share of its
-- member key, per 24 hours; NULL is runner.model_calls_per_day.
ALTER TABLE bots.config
  ADD COLUMN moderates            BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN mod_api_key_ref      TEXT,
  ADD COLUMN mod_reasoning_effort TEXT    NOT NULL DEFAULT 'medium'
                                  CHECK (mod_reasoning_effort IN ('default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh')),
  ADD COLUMN mod_max_steps        INTEGER NOT NULL DEFAULT 8 CHECK (mod_max_steps > 0),
  ADD COLUMN model_calls_per_day  INTEGER CHECK (model_calls_per_day >= 0);

-- A moderator's cycles keep their own schedule and cursor beside its member
-- visits': patrols every runner.moderation_patrol_minutes, early cycles for a
-- new report or hot thread, and a pause when the moderation key is capped.
ALTER TABLE bots.state
  ADD COLUMN mod_next_at       TIMESTAMPTZ,
  ADD COLUMN mod_early_at      TIMESTAMPTZ,
  ADD COLUMN mod_early_trigger TEXT CHECK (mod_early_trigger IN ('early', 'manual')),
  ADD COLUMN mod_cursor        TIMESTAMPTZ,
  ADD COLUMN mod_paused_until  TIMESTAMPTZ;

ALTER TABLE bots.runs DROP CONSTRAINT runs_kind_check;
ALTER TABLE bots.runs ADD CONSTRAINT runs_kind_check CHECK (kind IN ('wake', 'compaction', 'moderation'));

-- The role briefs: what the board is and how to be a member of it (every
-- bot), what a member who also moderates keeps in mind on ordinary visits,
-- and the moderator's brief for moderation cycles. Every version is kept; the
-- newest is current. With none, the runner uses personas/briefs/<name>.md.
CREATE TABLE bots.brief_versions (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       TEXT        NOT NULL CHECK (name IN ('member', 'moderator_member', 'moderation')),
  body       TEXT        NOT NULL,
  created_by TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX brief_versions_name_idx ON bots.brief_versions (name, id DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fritter_bots') THEN
    GRANT SELECT ON bots.brief_versions TO fritter_bots;
  END IF;
END
$$;
