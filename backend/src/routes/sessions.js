const router = require('express').Router();
const pool = require('../db/pool');

// ── Helpers ──────────────────────────────────────────────────────────────────

// True if the session exists AND belongs to the given user.
async function ownsSession(sessionId, userId) {
  const r = await pool.query(
    'SELECT 1 FROM sessions WHERE id = $1 AND user_id = $2',
    [sessionId, userId]
  );
  return r.rows.length > 0;
}

// True if exercise `exId` exists, belongs to session `sessionId`, AND that
// session belongs to `userId`. Verifies the full ownership chain.
async function ownsSessionExercise(sessionId, exId, userId) {
  const r = await pool.query(
    `SELECT 1
       FROM session_exercises se
       JOIN sessions s ON s.id = se.session_id
      WHERE se.id = $1 AND se.session_id = $2 AND s.user_id = $3`,
    [exId, sessionId, userId]
  );
  return r.rows.length > 0;
}

// Build the full session object (with exercises and sets) from an
// already-fetched session row — no re-query of the session itself. Used by
// callers that already hold the row (the list route).
async function hydrateSession(sess) {
  const exRes = await pool.query(
    'SELECT * FROM session_exercises WHERE session_id = $1 ORDER BY position ASC',
    [sess.id]
  );

  const exercises = await Promise.all(exRes.rows.map(async (ex) => {
    const setRes = await pool.query(
      'SELECT * FROM sets WHERE session_exercise_id = $1 ORDER BY position ASC',
      [ex.id]
    );
    return {
      id: ex.id,
      name: ex.name,
      sets: setRes.rows.map(s => ({
        id: s.id,
        reps: s.reps,
        weight: s.weight,
        savedAt: s.saved_at,
      })),
    };
  }));

  return {
    id: sess.id,
    startedAt: sess.started_at,
    finishedAt: sess.finished_at,
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

// PATCH /api/sessions/:id/finish — mark this user's session as finished
router.patch('/:id/finish', async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE sessions SET finished_at = NOW() WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to finish session' });
  }
});

// POST /api/sessions/:id/exercises — add an exercise to this user's session
// body: { id: string, name: string, position: number }
router.post('/:id/exercises', async (req, res) => {
  const { id, name, position } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id and name required' });
  try {
    if (!(await ownsSession(req.params.id, req.userId))) {
      return res.status(404).json({ error: 'Not found' });
    }
    await pool.query(
      'INSERT INTO session_exercises (id, session_id, name, position) VALUES ($1, $2, $3, $4)',
      [id, req.params.id, name, position ?? 0]
    );
    res.json({ ok: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add exercise' });
  }
});

// DELETE /api/sessions/:id/exercises/:exId — remove exercise from this user's session
router.delete('/:id/exercises/:exId', async (req, res) => {
  try {
    if (!(await ownsSessionExercise(req.params.id, req.params.exId, req.userId))) {
      return res.status(404).json({ error: 'Not found' });
    }
    await pool.query(
      'DELETE FROM session_exercises WHERE id = $1 AND session_id = $2',
      [req.params.exId, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove exercise' });
  }
});

// POST /api/sessions/:id/exercises/:exId/sets — add a set
// body: { id: string, position: number }
router.post('/:id/exercises/:exId/sets', async (req, res) => {
  const { id, position } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    if (!(await ownsSessionExercise(req.params.id, req.params.exId, req.userId))) {
      return res.status(404).json({ error: 'Not found' });
    }
    await pool.query(
      'INSERT INTO sets (id, session_exercise_id, position) VALUES ($1, $2, $3)',
      [id, req.params.exId, position ?? 0]
    );
    res.json({ ok: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add set' });
  }
});

// PATCH /api/sessions/:id/exercises/:exId/sets/:setId — update set fields
// body: { reps?: number, weight?: number, savedAt?: string }
router.patch('/:id/exercises/:exId/sets/:setId', async (req, res) => {
  const { reps, weight, savedAt } = req.body;
  try {
    if (!(await ownsSessionExercise(req.params.id, req.params.exId, req.userId))) {
      return res.status(404).json({ error: 'Not found' });
    }
    await pool.query(
      `UPDATE sets SET
         reps = COALESCE($1, reps),
         weight = COALESCE($2, weight),
         saved_at = COALESCE($3, saved_at)
       WHERE id = $4 AND session_exercise_id = $5`,
      [reps ?? null, weight ?? null, savedAt ?? null, req.params.setId, req.params.exId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update set' });
  }
});

// DELETE /api/sessions/:id/exercises/:exId/sets/:setId — remove a set
router.delete('/:id/exercises/:exId/sets/:setId', async (req, res) => {
  try {
    if (!(await ownsSessionExercise(req.params.id, req.params.exId, req.userId))) {
      return res.status(404).json({ error: 'Not found' });
    }
    await pool.query(
      'DELETE FROM sets WHERE id = $1 AND session_exercise_id = $2',
      [req.params.setId, req.params.exId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete set' });
  }
});

module.exports = router;
