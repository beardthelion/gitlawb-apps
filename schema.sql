-- Leaderboard storage for Beat the Bot.
--
-- A row is created when a run starts (so the clock is server-side and cannot be
-- edited in the browser) and completed only when ten valid proofs arrive.

CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  track        TEXT NOT NULL CHECK (track IN ('human', 'agent')),
  label        TEXT,
  requester_id TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  elapsed_ms   INTEGER
);

-- The leaderboard and percentile queries both read finished runs of one track
-- ordered by time, so that is the index.
CREATE INDEX IF NOT EXISTS idx_runs_track_elapsed
  ON runs (track, elapsed_ms) WHERE finished_at IS NOT NULL;

-- Abandoned runs are the common case (most people will not clear ten levels), so
-- unfinished rows are swept by age rather than kept forever.
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs (started_at);
