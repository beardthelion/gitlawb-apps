-- Two changes, one theme: say what was proved and what was merely claimed.
--
-- 1. Ranking gates on verification. Detection is unwinnable (an agent driving a
--    real browser produces real keystrokes), so the board stops pretending to
--    know what you are and instead ranks only claims someone has publicly
--    staked an account on. Unverified runs are still recorded and shown, just
--    not ranked.
--
-- 2. Input provenance, recorded and displayed as SELF-REPORTED. It is
--    client-supplied and therefore forgeable. It is not a gate and never blocks
--    a player; it catches someone pasting from another tab, not a determined
--    agent, and the UI says so.

ALTER TABLE runs ADD COLUMN input_keystrokes INTEGER;
ALTER TABLE runs ADD COLUMN input_pastes INTEGER;
ALTER TABLE runs ADD COLUMN input_pointer INTEGER;
ALTER TABLE runs ADD COLUMN input_blur INTEGER;

-- The ranked board reads verified runs by track and time.
CREATE INDEX IF NOT EXISTS idx_runs_ranked
  ON runs (track, verification, adjusted_ms) WHERE finished_at IS NOT NULL;
