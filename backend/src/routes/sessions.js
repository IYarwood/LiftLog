const router = require('express').Router();
const pool = require('../db/pool');

// ── Helpers ──────────────────────────────────────────────────────────────────

// Fetch a full session object (with exercises and sets) by session id
async function fetchSession(sessionId) {
  const sessRes = await pool.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
  if (!sessRes.rows.length) return null;
  const sess = sessRes.rows[0];

  const exRes = await pool.query(
    'SELECT * FROM session_exercises WHERE session_id = $1 ORDER BY position ASC',
    [sessionId]
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

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /api/sessions — list all completed sessions (no sets, for list views)
router.get('/', async (req, res) => {
  try {
    const sessRes = await pool.query(
      'SELECT * FROM sessions WHERE finished_at IS NOT NULL ORDER BY started_at DESC'
    );
    const sessions = await Promise.all(sessRes.rows.map(s => fetchSession(s.id)));
    res.json(sessions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// GET /api/sessions/active — get the current in-progress session (if any)
router.get('/active', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM sessions WHERE finished_at IS NULL ORDER BY started_at DESC LIMIT 1'
    );
    if (!result.rows.length) return res.json(null);
    const session = await fetchSession(result.rows[0].id);
    res.json(session);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch active session' });
  }
});

// GET /api/sessions/:id — get a single session with all data
router.get('/:id', async (req, res) => {
  try {
    const session = await fetchSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Not found' });
    res.json(session);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

// POST /api/sessions — start a new session
// body: { id: string, startedAt: string }
router.post('/', async (req, res) => {
  const { id, startedAt } = req.body;
  if (!id || !startedAt) return res.status(400).json({ error: 'id and startedAt required' });
  try {
    await pool.query(
      'INSERT INTO sessions (id, started_at) VALUES ($1, $2)',
      [id, startedAt]
    );
    res.json({ ok: true, id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// PATCH /api/sessions/:id/finish — mark session as finished
router.patch('/:id/finish', async (req, res) => {
  try {
    await pool.query(
      'UPDATE sessions SET finished_at = NOW() WHERE id = $1',
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to finish session' });
  }
});

// POST /api/sessions/:id/exercises — add an exercise to a session
// body: { id: string, name: string, position: number }
router.post('/:id/exercises', async (req, res) => {
  const { id, name, position } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id and name required' });
  try {
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

// DELETE /api/sessions/:id/exercises/:exId — remove exercise from session
router.delete('/:id/exercises/:exId', async (req, res) => {
  try {
    await pool.query('DELETE FROM session_exercises WHERE id = $1', [req.params.exId]);
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
    await pool.query(
      `UPDATE sets SET
        reps = COALESCE($1, reps),
        weight = COALESCE($2, weight),
        saved_at = COALESCE($3, saved_at)
       WHERE id = $4`,
      [reps ?? null, weight ?? null, savedAt ?? null, req.params.setId]
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
    await pool.query('DELETE FROM sets WHERE id = $1', [req.params.setId]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete set' });
  }
});

module.exports = router;
