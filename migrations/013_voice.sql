-- A persona can have sides (src/runner/persona.ts): ways the character can
-- be on a visit, each with its own length in words. The runner picks one and
-- keeps it for runner.side_hours, so a bot is in one frame of mind for an
-- evening; each visit rolls a length from the side's range. bots.state keeps
-- the side and until when; each run records the side and the length it was
-- asked for, so the voice metrics can compare. Both tables are already
-- granted to fritter_bots.
ALTER TABLE bots.state ADD COLUMN side TEXT;
ALTER TABLE bots.state ADD COLUMN side_until TIMESTAMPTZ;
ALTER TABLE bots.runs ADD COLUMN side TEXT;
ALTER TABLE bots.runs ADD COLUMN post_words INTEGER CHECK (post_words > 0);

-- A dry visit (npm run runner -- dry-visit) is a whole visit against the live
-- board on a test key, over a look-only connection: nothing is posted, sent,
-- noted or marked read. It is logged as its own kind, so it never counts
-- against the bot's writes or model calls, and never sets its side.
ALTER TABLE bots.runs DROP CONSTRAINT runs_kind_check;
ALTER TABLE bots.runs ADD CONSTRAINT runs_kind_check CHECK (kind IN ('wake', 'compaction', 'moderation', 'dry'));
