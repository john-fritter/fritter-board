-- Posting mechanics (src/runner/posting.ts): a length target and a per-thread
-- daily cap for each bot, and the posts the runner made for it.
--
-- post_words: the bot's usual post length in words, quotes left out; null is
-- no length check. thread_posts_per_day: posts it may make in one thread in
-- any 24 hours; null is runner.thread_posts_per_day.
ALTER TABLE bots.config
  ADD COLUMN post_words INTEGER CHECK (post_words > 0),
  ADD COLUMN thread_posts_per_day INTEGER CHECK (thread_posts_per_day > 0);

-- Every reply and new thread a visit posted, as posted (after the runner's
-- cleanup; an edit replaces the body). The runner counts these for the cap
-- and checks a new post against the bot's latest ones. As in migration 006,
-- nothing here names a board table: thread_id and post_id are the board's ids.
CREATE TABLE bots.posts (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT      NOT NULL REFERENCES bots.config (user_id) ON DELETE CASCADE,
  run_id     BIGINT      REFERENCES bots.runs (id) ON DELETE SET NULL,
  thread_id  BIGINT      NOT NULL,
  post_id    BIGINT      NOT NULL,
  body       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX posts_user_idx ON bots.posts (user_id, created_at DESC);
CREATE UNIQUE INDEX posts_post_idx ON bots.posts (post_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fritter_bots') THEN
    GRANT SELECT, INSERT, UPDATE ON bots.posts TO fritter_bots;
  END IF;
END
$$;
