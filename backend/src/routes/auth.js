const router = require('express').Router();
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const requireAuth = require('../middleware/auth');
const { signToken } = require('../auth/tokens');

// POST /api/auth/login — body { username, password }
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username.toLowerCase()]
    );
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid username or password' });

    const token = signToken({ userId: user.id, username: user.username });
    res.json({ token, username: user.username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me — returns the current user from the token
router.get('/me', requireAuth, (req, res) => {
  res.json({ username: req.username });
});

module.exports = router;
