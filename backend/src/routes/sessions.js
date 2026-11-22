const router = require('express').Router();
const pool = require('../db/pool');
const { parseExerciseName } = require('../validation/exerciseName');
const { toWeight } = require('../db/hydrate');
const { parseSetFields } = require('../validation/setFields');
const { EDIT_WINDOW_DAYS, EDIT_CLOSED_MSG, editableUntil } = require('../db/editWindow');

// ── Helpers ──────────────────────────────────────────────────────────────────

// Edit gate columns for a session row aliased `s`: is it finished, and if so,
// has its edit window closed? Compared against the DB clock. $N = window days.
const EDIT_STATE_SQL = (n) =>
  `s.finished_at IS NOT NULL AS finished,
   (s.finished_at IS NOT NULL AND s.finished_at < NOW() - make_interval(days => $${n})) AS closed`;

// Exercise `exId` in session `sessionId` owned by `userId`, with the session's
// edit state: { finished, closed }, or null if the chain doesn't match.
async function ownsSessionExercise(sessionId, exId, userId) {
  const r = await pool.query(
    `SELECT ${EDIT_STATE_SQL(4)}
       FROM session_exercises se
       JOIN sessions s ON s.id = se.session_id
      WHERE se.id = $1 AND se.session_id = $2 AND s.user_id = $3`,
    [exId, sessionId, userId, EDIT_WINDOW_DAYS]
  );
  return r.rows[0] || null;
}

// Every write to a session's exercises/sets goes through this: 404 unless the
// caller owns it, 403 once a FINISHED workout is past its edit window. In-progress
// workouts are never limited. Returns the edit state, or null if it already
// sent the error response.
async function editGate(res, sessionId, exId, userId) {
  const st = await ownsSessionExercise(sessionId, exId, userId);
  if (!st) { res.status(404).json({ error: 'Not found' }); return null; }
  if (st.closed) { res.status(403).json({ error: EDIT_CLOSED_MSG, code: 'edit_window_closed' }); return null; }
  return st;
}

// Stamp a FINISHED session as edited (no-op for an in-progress one).
async function markEdited(sessionId, st) {
  if (!st.finished) return;
  await pool.query(
    'UPDATE sessions SET edited_at = NOW() WHERE id = $1 AND finished_at IS NOT NULL',
    [sessionId]
  );
}

// Build the full session object (with exercises and sets) from an
// already-fetched session row — no re-query of the session itself. Used by
// callers that already hold the row (the list route).
async function hydrateSession(sess) {
  const exRes = await pool.query(
    'SELECT * FROM session_exercises WHERE session_id = $1 ORDER BY position ASC, created_at ASC, id ASC',
    [sess.id]
  );

  const exercises = await Promise.all(exRes.rows.map(async (ex) => {
    const setRes = await pool.query(
      'SELECT * FROM sets WHERE session_exercise_id = $1 ORDER BY position ASC, created_at ASC, id ASC',
      [ex.id]
    );
    return {
      id: ex.id,
      name: ex.name,
      sets: setRes.rows.map(s => ({
        id: s.id,
        reps: s.reps,
        weight: toWeight(s.weight),
        savedAt: s.saved_at,
      })),
    };
  }));

  return {
    id: sess.id,
    startedAt: sess.started_at,
    finishedAt: sess.finished_at,
    editedAt: sess.edited_at || null,
    editableUntil: editableUntil(sess.finished_at),
    exercises,
  };
}

// Fetch a full session by id — scoped to its owner. Returns null if the session
// does not exist or is not owned by userId. For callers that don't already hold
// the row (GET /:id and GET /active).
async function fetchSession(sessionId, userId) {
  const sessRes = await pool.query(
    'SELECT * FROM sessions WHERE id = $1 AND user_id = $2',
    [sessionId, userId]
  );
  if (!sessRes.rows.length) return null;
  return hydrateSession(sessRes.rows[0]);
}

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /api/sessions — list this user's completed sessions
router.get('/', async (req, res) => {
  try {
    const sessRes = await pool.query(
      'SELECT * FROM sessions WHERE finished_at IS NOT NULL AND user_id = $1 ORDER BY started_at DESC',
      [req.userId]
    );
    const sessions = await Promise.all(sessRes.rows.map(s => hydrateSession(s)));
    res.json(sessions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// GET /api/sessions/active — this user's in-progress session (if any)
router.get('/active', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM sessions WHERE finished_at IS NULL AND user_id = $1 ORDER BY started_at DESC LIMIT 1',
      [req.userId]
    );
    if (!result.rows.length) return res.json(null);
    const session = await fetchSession(result.rows[0].id, req.userId);
    res.json(session);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch active session' });
  }
});

// GET /api/sessions/:id — single session, owned by this user (404 otherwise)
router.get('/:id', async (req, res) => {
  try {
    const session = await fetchSession(req.params.id, req.userId);
    if (!session) return res.status(404).json({ error: 'Not found' });
    res.json(session);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

// POST /api/sessions — start a new session for this user
// body: { id: string, startedAt: string }
router.post('/', async (req, res) => {
  const { id, startedAt } = req.body;
  if (!id || !startedAt) return res.status(400).json({ error: 'id and startedAt required' });
  try {
    await pool.query(
      'INSERT INTO sessions (id, started_at, user_id) VALUES ($1, $2, $3)',
      [id, startedAt, req.userId]
    );
    res.json({ ok: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// PATCH /api/sessions/:id/finish — mark this user's session as finished.
// Finishing an already-finished session is a no-op 200 (a retried request): it
// must NOT move finished_at, or an old workout could be pulled into this week's
// leaderboard and get a fresh edit window.
router.patch('/:id/finish', async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE sessions SET finished_at = NOW() WHERE id = $1 AND user_id = $2 AND finished_at IS NULL',
      [req.params.id, req.userId]
    );
    if (result.rowCount === 0) {
      const exists = await pool.query('SELECT 1 FROM sessions WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
      if (!exists.rows.length) return res.status(404).json({ error: 'Not found' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to finish session' });
  }
});

// DELETE /api/sessions/:id — delete one of this user's workouts (with its
// exercises and sets). A finished workout only within its edit window.
router.delete('/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${EDIT_STATE_SQL(3)} FROM sessions s WHERE s.id = $1 AND s.user_id = $2`,
      [req.params.id, req.userId, EDIT_WINDOW_DAYS]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    if (r.rows[0].closed) return res.status(403).json({ error: EDIT_CLOSED_MSG, code: 'edit_window_closed' });
    await pool.query('DELETE FROM sessions WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete workout' });
  }
});

// POST /api/sessions/:id/exercises — add an exercise to this user's session
// body: { id: string, name: string (trimmed; 1–60 chars) }
// `position` is assigned here as (highest in the session) + 1, so removing an
// exercise never frees a slot that a later add would reuse. A client-sent
// `position` is ignored (older clients sent their local count, which repeated).
// An exercise appears at most once per session, compared ignoring case:
//   - 409 { error, id, name } if the session already has that name under a
//     different id (id/name = the existing entry, so the client can jump to it).
//   - 200 if this exact { id, name } is already there — a re-sent request
//     (e.g. a retry after a dropped response) is idempotent, not an error.
//   - 409 if `id` is already used by a different exercise.
// The session row is locked (FOR UPDATE) for the check + insert, so two
// concurrent adds of the same name to one session can't both get in.
router.post('/:id/exercises', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  const { name, error } = parseExerciseName(req.body.name);
  if (error) return res.status(400).json({ error });
  let client;
  let brokenErr;   // set if ROLLBACK itself failed: the connection is unusable
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const own = await client.query(
      `SELECT ${EDIT_STATE_SQL(3)} FROM sessions s WHERE s.id = $1 AND s.user_id = $2 FOR UPDATE`,
      [req.params.id, req.userId, EDIT_WINDOW_DAYS]
    );
    if (!own.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Not found' });
    }
    if (own.rows[0].closed) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: EDIT_CLOSED_MSG, code: 'edit_window_closed' });
    }
    const dup = await client.query(
      `SELECT id, session_id, name FROM session_exercises
        WHERE id = $1 OR (session_id = $2 AND lower(name) = lower($3))`,
      [id, req.params.id, name]
    );
    if (dup.rows.length) {
      await client.query('ROLLBACK');
      const same = dup.rows.find(r => r.id === id);
      if (same && same.session_id === req.params.id && same.name.toLowerCase() === name.toLowerCase()) {
        return res.json({ ok: true, id });   // replay of an add that already succeeded
      }
      if (same) return res.status(409).json({ error: 'exercise id already in use' });
      return res.status(409).json({
        error: 'that exercise is already in this workout',
        id: dup.rows[0].id,
        name: dup.rows[0].name,
      });
    }
    // Session row is locked, so MAX is stable for this insert.
    await client.query(
      `INSERT INTO session_exercises (id, session_id, name, position)
       SELECT $1, $2, $3, COALESCE(MAX(position) + 1, 0)
         FROM session_exercises WHERE session_id = $2`,
      [id, req.params.id, name]
    );
    if (own.rows[0].finished) {
      await client.query('UPDATE sessions SET edited_at = NOW() WHERE id = $1', [req.params.id]);
    }
    await client.query('COMMIT');
    res.json({ ok: true, id });
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (rbErr) { brokenErr = rbErr; }
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to add exercise' });
  } finally {
    // release(err) destroys the connection instead of returning it to the pool
    // (it could still be mid-transaction).
    if (client) client.release(brokenErr);
  }
});

// DELETE /api/sessions/:id/exercises/:exId — remove exercise from this user's session
router.delete('/:id/exercises/:exId', async (req, res) => {
  try {
    const st = await editGate(res, req.params.id, req.params.exId, req.userId);
    if (!st) return;
    await pool.query(
      'DELETE FROM session_exercises WHERE id = $1 AND session_id = $2',
      [req.params.exId, req.params.id]
    );
    await markEdited(req.params.id, st);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove exercise' });
  }
});

// POST /api/sessions/:id/exercises/:exId/sets — add a set
// body: { id: string }
// `position` is (highest in the exercise) + 1, assigned here for the same reason
// as exercises; a client-sent `position` is ignored. Two truly concurrent adds
// could tie, which the created_at/id tiebreak in the read query orders stably.
router.post('/:id/exercises/:exId/sets', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    const st = await editGate(res, req.params.id, req.params.exId, req.userId);
    if (!st) return;
    await pool.query(
      `INSERT INTO sets (id, session_exercise_id, position)
       SELECT $1, $2, COALESCE(MAX(position) + 1, 0)
         FROM sets WHERE session_exercise_id = $2`,
      [id, req.params.exId]
    );
    await markEdited(req.params.id, st);
    res.json({ ok: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add set' });
  }
});

// PATCH /api/sessions/:id/exercises/:exId/sets/:setId — update set fields
// body: { reps?: number|null, weight?: number|null, savedAt?: string }
// Only fields present in the body change: an omitted field keeps its value,
// an explicit null (or '') clears it. reps: whole number 0–9999; weight:
// 0–9999.99 (NUMERIC(6,2)); numeric strings are accepted. savedAt can be set
// but not cleared. Out-of-range or malformed values are a 400
// (see validation/setFields.js).
router.patch('/:id/exercises/:exId/sets/:setId', async (req, res) => {
  const { fields, error } = parseSetFields(req.body);
  if (error) return res.status(400).json({ error });
  const has = (k) => Object.prototype.hasOwnProperty.call(fields, k);
  try {
    const st = await editGate(res, req.params.id, req.params.exId, req.userId);
    if (!st) return;
    // $1/$3 say whether reps/weight were sent; if so, $2/$4 (possibly null)
    // replace the stored value.
    await pool.query(
      `UPDATE sets SET
         reps     = CASE WHEN $1::boolean THEN $2::integer ELSE reps END,
         weight   = CASE WHEN $3::boolean THEN $4::numeric ELSE weight END,
         saved_at = COALESCE($5::timestamptz, saved_at)
       WHERE id = $6 AND session_exercise_id = $7`,
      [has('reps'), has('reps') ? fields.reps : null,
       has('weight'), has('weight') ? fields.weight : null,
       has('savedAt') ? fields.savedAt : null,
       req.params.setId, req.params.exId]
    );
    await markEdited(req.params.id, st);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update set' });
  }
});

// DELETE /api/sessions/:id/exercises/:exId/sets/:setId — remove a set
router.delete('/:id/exercises/:exId/sets/:setId', async (req, res) => {
  try {
    const st = await editGate(res, req.params.id, req.params.exId, req.userId);
    if (!st) return;
    await pool.query(
      'DELETE FROM sets WHERE id = $1 AND session_exercise_id = $2',
      [req.params.setId, req.params.exId]
    );
    await markEdited(req.params.id, st);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete set' });
  }
});

module.exports = router;
