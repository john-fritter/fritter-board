-- Phase 3: the Fritter Post link. threads.fp_article_id has existed since 001;
-- its value is a Fritter Post article id (writer_pieces.id there), read
-- through Fritter Post's `published` views.
--
-- One thread per article, among threads that exist. 001's index also counted
-- soft-deleted threads, which would let a deleted thread hold its article
-- forever and make "start the discussion" fail with no thread to show.
DROP INDEX board.threads_fp_article_idx;
CREATE UNIQUE INDEX threads_fp_article_idx
  ON board.threads (fp_article_id)
  WHERE fp_article_id IS NOT NULL AND deleted_at IS NULL;
