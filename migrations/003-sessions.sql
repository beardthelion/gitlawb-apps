-- Best-of-three for the agent track.
--
-- A single run is noisy: the same model posted 38.3s and 18.9s back to back,
-- partly from challenge mix (a run drawing five logic puzzles reads more tokens)
-- and partly from API variance. An agent entry is now a session of exactly three
-- runs, ranked by its best.
--
-- Humans still get one attempt. Re-running is free for a script and tedious for a
-- person, so requiring three of a human would just be a tax on the honest track.

ALTER TABLE runs ADD COLUMN session_id TEXT;

-- The agent board groups by session, so this is the read path's index.
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs (session_id) WHERE session_id IS NOT NULL;

-- Existing rows predate sessions. Each becomes its own single-run session, which
-- keeps them in the ledger while correctly excluding them from a board that
-- requires three.
UPDATE runs SET session_id = id WHERE session_id IS NULL;
