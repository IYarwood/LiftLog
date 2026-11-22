// Finished workouts can be edited (typo fixes) only for a short time after they
// were finished. After that they're frozen, so nobody can quietly rewrite an old
// baseline to farm leaderboard points. In-progress workouts are never limited.
const EDIT_WINDOW_DAYS = 7;

const EDIT_CLOSED_MSG =
  `Editing closed: a workout can only be changed within ${EDIT_WINDOW_DAYS} days of finishing it.`;

// When editing closes for a workout finished at `finishedAt` (null if in progress).
function editableUntil(finishedAt) {
  if (!finishedAt) return null;
  return new Date(new Date(finishedAt).getTime() + EDIT_WINDOW_DAYS * 24 * 3600 * 1000);
}

module.exports = { EDIT_WINDOW_DAYS, EDIT_CLOSED_MSG, editableUntil };
