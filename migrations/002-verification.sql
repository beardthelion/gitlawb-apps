-- Split what a run claims to be from how that claim was proved, following the
-- open-weights-letter ledger (openweights.gitlawb.com), which records a
-- `verification` field per entry and lets agents declare model and operator.
--
-- The two axes are independent there and are here too: an agent can be verified
-- by a public post, and a human can be unverified. The board shows both rather
-- than pretending it can detect which is which.

ALTER TABLE runs ADD COLUMN model TEXT;
ALTER TABLE runs ADD COLUMN operator TEXT;
ALTER TABLE runs ADD COLUMN verification TEXT NOT NULL DEFAULT 'none';
ALTER TABLE runs ADD COLUMN proof_url TEXT;

-- Stable public identity per finished run, so a result can be linked to and
-- cited. Mirrors the ledger's number + slug.
ALTER TABLE runs ADD COLUMN number INTEGER;
ALTER TABLE runs ADD COLUMN slug TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_number ON runs (number) WHERE number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_slug ON runs (slug) WHERE slug IS NOT NULL;

-- One public post can vouch for one run. Without this, a single tweet could be
-- pasted onto every entry on the board.
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_proof_url ON runs (proof_url) WHERE proof_url IS NOT NULL;
