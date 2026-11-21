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
