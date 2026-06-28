const express = require('express');
const cors = require('cors');
const requireAuth = require('./middleware/auth');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/auth', require('./routes/auth'));
app.use('/api/exercises', require('./routes/exercises'));
app.use('/api/sessions', requireAuth, require('./routes/sessions'));

app.get('/api/health', (req, res) => res.json({ ok: true }));

module.exports = app;
