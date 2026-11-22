-- Run this once to set up the database
-- psql -U postgres -d liftlog -f schema.sql

CREATE TABLE IF NOT EXISTS exercises (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Guard: refuse to build the index while case-variant duplicates exist.
DO $$
DECLARE dups TEXT;
BEGIN
  SELECT string_agg(variants, '; ') INTO dups FROM (
    SELECT string_agg(quote_literal(name), ', ' ORDER BY name) AS variants
      FROM exercises GROUP BY lower(name) HAVING count(*) > 1
  ) d;
  IF dups IS NOT NULL THEN
    RAISE EXCEPTION 'exercises has names that differ only by case: %', dups
      USING HINT = 'Rename or delete all but one of each group, then re-run. See HANDOFF.md.';
  END IF;
END $$;

-- One exercise per name, ignoring case ("Squat" blocks "squat").
CREATE UNIQUE INDEX IF NOT EXISTS idx_exercises_name_lower ON exercises (lower(name));

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,           -- client-generated uid
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Per-user ownership of sessions (nullable; backfilled by scripts/backfill-owner.js)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

-- Edited marker: set when a FINISHED session is changed (within the edit window)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS session_exercises (
  id TEXT PRIMARY KEY,           -- client-generated uid
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,  -- order within session
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sets (
  id TEXT PRIMARY KEY,           -- client-generated uid
  session_exercise_id TEXT NOT NULL REFERENCES session_exercises(id) ON DELETE CASCADE,
  reps INTEGER,
  weight NUMERIC(6,2),
  saved_at TIMESTAMPTZ,
  position INTEGER NOT NULL DEFAULT 0,  -- order within exercise
  created_at TIMESTAMPTZ DEFAULT NOW()
);

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

-- Seed default exercises
INSERT INTO exercises (name) VALUES
  ('Bench Press'),('Squat'),('Deadlift'),('Overhead Press'),('Barbell Row'),
  ('Pull-Up'),('Dumbbell Curl'),('Tricep Pushdown'),('Leg Press'),('Lateral Raise'),
  ('Romanian Deadlift'),('Cable Fly'),('Incline Dumbbell Press'),('Face Pull'),('Hip Thrust')
-- No conflict target: skip a default that already exists in any case
-- (idx_exercises_name_lower), not just an exact match.
ON CONFLICT DO NOTHING;
