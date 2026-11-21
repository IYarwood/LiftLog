-- Friends feature migration (idempotent; safe to re-run).
-- Same DDL as the friendships section of schema.sql, without the exercise seed,
-- so applying it to an existing DB doesn't re-add library exercises a user removed.
-- Apply: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/2026-11-21-friends.sql

-- Friendships (request + accept). One row per pair of users, whichever direction
-- it was requested in. Decline / cancel / remove simply delete the row.
CREATE TABLE IF NOT EXISTS friendships (
  id SERIAL PRIMARY KEY,
  requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  CHECK (requester_id <> addressee_id)
);
-- At most one row per unordered pair (A→B and B→A can't both exist)
CREATE UNIQUE INDEX IF NOT EXISTS idx_friendships_pair
  ON friendships (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id));
CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON friendships(addressee_id);

-- Activity feed: friends' finished sessions, newest first
CREATE INDEX IF NOT EXISTS idx_sessions_user_finished
  ON sessions(user_id, finished_at DESC) WHERE finished_at IS NOT NULL;
