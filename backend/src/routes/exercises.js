const router = require('express').Router();
const pool = require('../db/pool');
const { parseExerciseName } = require('../validation/exerciseName');

// GET /api/exercises — list all exercises
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT name FROM exercises ORDER BY name ASC');
    res.json(result.rows.map(r => r.name));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch exercises' });
  }
});

// POST /api/exercises — add a new exercise
// body: { name: string }  (trimmed; 1–60 chars, see validation/exerciseName.js)
router.post('/', async (req, res) => {
  const { name, error } = parseExerciseName(req.body && req.body.name);
  if (error) return res.status(400).json({ error });
  try {
    await pool.query(
      'INSERT INTO exercises (name) VALUES ($1) ON CONFLICT (name) DO NOTHING',
      [name]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add exercise' });
  }
});

// PATCH /api/exercises/:name — rename a library exercise
// body: { name: string }  (same validation as POST)
// Changes the shared library row only. Logged workouts (session_exercises)
// keep the name they were recorded with — history is never rewritten.
// 404 if :name doesn't exist; 409 if another exercise already has the new name
// ignoring case (the add UI treats names case-insensitively too). Changing only
// the case of the same exercise is allowed.
router.patch('/:name', async (req, res) => {
  const { name, error } = parseExerciseName(req.body && req.body.name);
  if (error) return res.status(400).json({ error });
  const oldName = req.params.name;
  try {
    const cur = await pool.query('SELECT id FROM exercises WHERE name = $1', [oldName]);
    if (!cur.rows.length) return res.status(404).json({ error: 'exercise not found' });
    const id = cur.rows[0].id;
    const clash = await pool.query(
      'SELECT 1 FROM exercises WHERE lower(name) = lower($1) AND id <> $2 LIMIT 1',
      [name, id]
    );
    if (clash.rows.length) return res.status(409).json({ error: 'an exercise with that name already exists' });
    const upd = await pool.query('UPDATE exercises SET name = $1 WHERE id = $2', [name, id]);
    if (!upd.rowCount) return res.status(404).json({ error: 'exercise not found' });  // deleted meanwhile
    res.json({ ok: true, name });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'an exercise with that name already exists' });
    console.error(err);
    res.status(500).json({ error: 'Failed to rename exercise' });
  }
});

// DELETE /api/exercises/:name — remove an exercise from library
router.delete('/:name', async (req, res) => {
  try {
    await pool.query('DELETE FROM exercises WHERE name = $1', [req.params.name]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete exercise' });
  }
});

module.exports = router;
