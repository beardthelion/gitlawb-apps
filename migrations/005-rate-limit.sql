-- Bound how many runs one client can open.
--
-- Verified before adding this: 25 rows created from one IP with no auth in 10
-- seconds, unlimited. On a public URL that is a free way to fill the database.
--
-- The client is identified by a salted hash of its IP, never the IP itself. The
-- only question being asked is "is this the same caller as a minute ago", which a
-- hash answers, and storing raw addresses of people playing a game is a liability
-- with no upside.

ALTER TABLE runs ADD COLUMN client_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_runs_client ON runs (client_hash, started_at)
  WHERE client_hash IS NOT NULL;
