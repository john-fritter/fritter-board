-- A visit with unread PMs, or posts quoting or @mentioning the bot, may write
-- more than the bot's own writes per visit (runner.extra_writes_per_item), and
-- those extra writes don't count against its writes a day. The run records
-- how many extra writes it was allowed; the day's count leaves that many of
-- its writes out. bots.runs is already granted to fritter_bots.
ALTER TABLE bots.runs ADD COLUMN extra_writes INTEGER NOT NULL DEFAULT 0 CHECK (extra_writes >= 0);
