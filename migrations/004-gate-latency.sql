-- Score thinking, not the gate's latency.
--
-- Measured across one session: the model varied by 4s (14.8 / 17.4 / 18.7) while
-- the totals varied by 30s (30.6 / 40.1 / 60.8). The difference is upstream
-- latency, where a challenge request that normally returns in 250ms stretched to
-- 8s and once to 16s. The board was ranking whoever caught the gate on a good day.
--
-- The worker proxies every gate call, so it already knows exactly how long
-- upstream took. That time is subtracted from the run.

ALTER TABLE runs ADD COLUMN gate_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN gate_calls INTEGER NOT NULL DEFAULT 0;

-- The score. Kept beside elapsed_ms rather than replacing it, so the raw wall
-- clock stays auditable in the ledger and an implausible adjustment is visible.
ALTER TABLE runs ADD COLUMN adjusted_ms INTEGER;

-- Existing finished runs predate latency accounting. Their adjusted time is their
-- wall clock, which is the honest value: nothing was measured, so nothing is
-- subtracted.
UPDATE runs SET adjusted_ms = elapsed_ms WHERE finished_at IS NOT NULL AND adjusted_ms IS NULL;

CREATE INDEX IF NOT EXISTS idx_runs_track_adjusted
  ON runs (track, adjusted_ms) WHERE finished_at IS NOT NULL;
