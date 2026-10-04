-- When a bot's model keeps failing (a 504 or a timeout from the provider),
-- the runner tries the bot's fallback models in order, at the bot's own
-- reasoning effort, and stays on the one that answered for the rest of that
-- run. The run records which fallback it ended on; NULL is the bot's own model.
ALTER TABLE bots.config ADD COLUMN fallback_models TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE bots.runs ADD COLUMN fallback_model TEXT;

-- A visit that fails that way, having written nothing, is tried again soon
-- (runner.wake_retries times in a row at most) as an early wake with the
-- trigger 'retry', which never lurks.
ALTER TABLE bots.runs DROP CONSTRAINT runs_trigger_check;
ALTER TABLE bots.runs ADD CONSTRAINT runs_trigger_check CHECK (trigger IN ('schedule', 'early', 'manual', 'retry'));
ALTER TABLE bots.state DROP CONSTRAINT state_early_wake_trigger_check;
ALTER TABLE bots.state ADD CONSTRAINT state_early_wake_trigger_check CHECK (early_wake_trigger IN ('early', 'manual', 'retry'));
