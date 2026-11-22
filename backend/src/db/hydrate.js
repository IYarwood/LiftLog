const pool = require('./pool');

// sets.weight is NUMERIC(6,2), which node-postgres returns as a string
// ("225.00"). Send it as a JSON number (225, 225.5, 102.25) so every client
// view shows it without trailing zeros. null stays null.
function toWeight(w) {
  return w === null || w === undefined ? null : Number(w);
}

// Hydrate many already-fetched session rows (exercises + sets) in two queries
// total, instead of one round-trip per session/exercise. Output shape matches
// hydrateSession() in routes/sessions.js, plus `username` when the row has one.
async function hydrateSessions(rows) {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);

  const exRes = await pool.query(
    'SELECT * FROM session_exercises WHERE session_id = ANY($1) ORDER BY position ASC, created_at ASC, id ASC',
    [ids]
  );
  const exIds = exRes.rows.map(e => e.id);
  const setRes = exIds.length
    ? await pool.query(
        'SELECT * FROM sets WHERE session_exercise_id = ANY($1) ORDER BY position ASC, created_at ASC, id ASC',
        [exIds]
      )
    : { rows: [] };

  const setsByEx = new Map();
  for (const s of setRes.rows) {
    if (!setsByEx.has(s.session_exercise_id)) setsByEx.set(s.session_exercise_id, []);
    setsByEx.get(s.session_exercise_id).push({
      id: s.id,
      reps: s.reps,
      weight: toWeight(s.weight),
      savedAt: s.saved_at,
    });
  }
  const exBySession = new Map();
  for (const ex of exRes.rows) {
    if (!exBySession.has(ex.session_id)) exBySession.set(ex.session_id, []);
    exBySession.get(ex.session_id).push({
      id: ex.id,
      name: ex.name,
      sets: setsByEx.get(ex.id) || [],
    });
  }

  return rows.map(r => {
    const out = {
      id: r.id,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      exercises: exBySession.get(r.id) || [],
    };
    if (r.username !== undefined) out.username = r.username;
    return out;
  });
}

module.exports = { hydrateSessions, toWeight };
