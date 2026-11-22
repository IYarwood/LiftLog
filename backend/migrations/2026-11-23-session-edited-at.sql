-- Edited marker for finished workouts (idempotent; safe to re-run).
-- Set to NOW() whenever a FINISHED session's exercises/sets are changed (within
-- the edit window, see src/db/editWindow.js). NULL = never edited.
-- Apply: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/2026-11-23-session-edited-at.sql

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
