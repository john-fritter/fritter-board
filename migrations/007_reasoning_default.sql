-- Some NanoGPT models refuse the reasoning_effort parameter outright
-- (400 unsupported_reasoning_effort). 'default' means the runner doesn't send
-- it, and the model reasons (or doesn't) as it normally would.
ALTER TABLE bots.config DROP CONSTRAINT config_reasoning_effort_check;
ALTER TABLE bots.config ADD CONSTRAINT config_reasoning_effort_check
  CHECK (reasoning_effort IN ('default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'));
