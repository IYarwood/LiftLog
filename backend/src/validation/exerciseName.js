// Shared validation for exercise names, used everywhere a name enters the
// system (the exercise library and exercises added to a session).
// Applies to new input only — existing rows are never re-validated.

const MAX_EXERCISE_NAME_LENGTH = 60;

// Title Case for exercise names: the first letter of each space- or
// hyphen-separated part is uppercased ("leg curl" -> "Leg Curl", "push-ups" ->
// "Push-Ups"); an opening bracket before it is skipped ("(cable)" -> "(Cable)").
// Letters typed as capitals are never lowercased, so "RDL", "EZ bar curl" ->
// "EZ Bar Curl" and "McGill" keep their capitals. Runs of whitespace collapse
// to one space. Expects an already-trimmed string.
function titleCaseExerciseName(name) {
  return name
    .replace(/\s+/g, ' ')
    .replace(/(^|[ -])([(\[{]?)(\p{Ll})/gu, (m, sep, open, ch) => {
      const up = ch.toUpperCase();
      // Skip letters whose uppercase is more than one character (e.g. "ß").
      return sep + open + (up.length === 1 ? up : ch);
    });
}

// Returns { name } (trimmed, Title Cased) on success, or { error } with a
// message suitable for a 400 response.
function parseExerciseName(raw) {
  if (typeof raw !== 'string') return { error: 'name required' };
  const name = titleCaseExerciseName(raw.trim());
  if (!name) return { error: 'name required' };
  if (name.length > MAX_EXERCISE_NAME_LENGTH) {
    return { error: `name must be at most ${MAX_EXERCISE_NAME_LENGTH} characters` };
  }
  // "." and ".." (and any all-dots name) can't be addressed as
  // /api/exercises/:name — URL normalisation turns them into path segments.
  if (/^\.+$/.test(name)) return { error: 'name cannot be only dots' };
  return { name };
}

module.exports = { MAX_EXERCISE_NAME_LENGTH, parseExerciseName, titleCaseExerciseName };
