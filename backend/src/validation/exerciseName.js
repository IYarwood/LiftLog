// Shared validation for exercise names, used everywhere a name enters the
// system (the exercise library and exercises added to a session).
// Applies to new input only — existing rows are never re-validated.

const MAX_EXERCISE_NAME_LENGTH = 60;

// Returns { name } (trimmed) on success, or { error } with a message suitable
// for a 400 response.
function parseExerciseName(raw) {
  if (typeof raw !== 'string') return { error: 'name required' };
  const name = raw.trim();
  if (!name) return { error: 'name required' };
  if (name.length > MAX_EXERCISE_NAME_LENGTH) {
    return { error: `name must be at most ${MAX_EXERCISE_NAME_LENGTH} characters` };
  }
  return { name };
}

module.exports = { MAX_EXERCISE_NAME_LENGTH, parseExerciseName };
