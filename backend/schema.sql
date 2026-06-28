-- Run this once to set up the database
-- psql -U postgres -d liftlog -f schema.sql

CREATE TABLE IF NOT EXISTS exercises (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

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

-- Seed default exercises
INSERT INTO exercises (name) VALUES
  ('Bench Press'),('Squat'),('Deadlift'),('Overhead Press'),('Barbell Row'),
  ('Pull-Up'),('Dumbbell Curl'),('Tricep Pushdown'),('Leg Press'),('Lateral Raise'),
  ('Romanian Deadlift'),('Cable Fly'),('Incline Dumbbell Press'),('Face Pull'),('Hip Thrust')
ON CONFLICT (name) DO NOTHING;
