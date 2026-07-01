const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const requireAuth = require('./middleware/auth');

const app = express();

app.use(cors());
app.use(express.json());

// Throttle brute-force password guessing. Mounted on the specific /login path so
// /api/auth/me (hit on every app boot) stays unthrottled. Under test the ceiling
// is raised so the suite's repeated logins don't trip a 429.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,                              // 15 minutes
  max: process.env.NODE_ENV === 'test' ? 1000 : 10,     // attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, try again later' },
});
app.use('/api/auth/login', loginLimiter);

app.use('/api/auth', require('./routes/auth'));
app.use('/api/exercises', require('./routes/exercises'));
app.use('/api/sessions', requireAuth, require('./routes/sessions'));

app.get('/api/health', (req, res) => res.json({ ok: true }));

module.exports = app;
