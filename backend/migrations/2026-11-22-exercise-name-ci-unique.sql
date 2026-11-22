-- Case-insensitive uniqueness for exercise names (idempotent; safe to re-run).
-- Same DDL as the exercises section of schema.sql, without the exercise seed.
-- Apply: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f migrations/2026-11-22-exercise-name-ci-unique.sql
--
-- If the library already holds names that differ only by case ("Squat" and
-- "squat"), the guard below aborts with the offending names and nothing is
-- changed. Resolve them by hand (see HANDOFF.md) and re-run.

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
