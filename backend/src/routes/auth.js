const router = require('express').Router();
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const requireAuth = require('../middleware/auth');
const { signToken } = require('../auth/tokens');

// A real cost-10 bcrypt hash of an arbitrary string, precomputed so the
// no-such-user branch spends the same time as a genuine comparison. Same cost
// factor (10) as create-user.js, so the timing matches. Compared against, never
// matched — login still fails because there is no user.
const DUMMY_HASH = '$2a$10$VJUSVCuINvanMRFrFm0xx.jf/kiR4v3l..wYNmZsw0KospdVVauzO';

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
    // Always run exactly one bcrypt.compare — against the real hash when the
    // user exists, against DUMMY_HASH otherwise — so both branches cost the
    // same and response time can't reveal whether the username exists.
    const hash = user ? user.password_hash : DUMMY_HASH;
    const ok = await bcrypt.compare(password, hash);
    if (!user || !ok) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

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
