const router = require('express').Router();
const pool = require('../db/pool');
const { hydrateSessions } = require('../db/hydrate');
const { parsePage, pageResponse, CURSOR_TS } = require('../db/paging');

// All routes here are mounted behind requireAuth, so req.userId is the caller.
// Other users are addressed by username; user ids are never sent to the client.

const SEARCH_LIMIT = 10;

function normUsername(u) {
  return typeof u === 'string' ? u.trim().toLowerCase() : '';
}

// Escape LIKE wildcards so a search for "a_" or "%" is a literal prefix.
function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

// ── Relationship helpers ─────────────────────────────────────────────────────

async function findUserId(username) {
  const r = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  return r.rows.length ? r.rows[0].id : null;
}

// The friendship row between two users, in either direction (or null).
async function findFriendship(a, b) {
  const r = await pool.query(
    `SELECT * FROM friendships
      WHERE (requester_id = $1 AND addressee_id = $2)
         OR (requester_id = $2 AND addressee_id = $1)`,
    [a, b]
  );
  return r.rows[0] || null;
}

// Id of `username` ONLY if they and `userId` are accepted friends; else null.
// This is the single authorization gate for reading another user's sessions.
async function acceptedFriendId(userId, username) {
  const r = await pool.query(
    `SELECT u.id
       FROM users u
       JOIN friendships f
         ON f.status = 'accepted'
        AND ((f.requester_id = $1 AND f.addressee_id = u.id)
          OR (f.addressee_id = $1 AND f.requester_id = u.id))
      WHERE u.username = $2`,
    [userId, username]
  );
  return r.rows.length ? r.rows[0].id : null;
}

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /api/friends — friends + incoming/outgoing pending requests
router.get('/', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT f.status, f.created_at, f.accepted_at,
              (f.requester_id = $1) AS outgoing,
              u.username
         FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
        WHERE f.requester_id = $1 OR f.addressee_id = $1
        ORDER BY u.username ASC`,
      [req.userId]
    );
    const out = { friends: [], incoming: [], outgoing: [] };
    for (const row of r.rows) {
      if (row.status === 'accepted') out.friends.push({ username: row.username, since: row.accepted_at });
      else if (row.outgoing) out.outgoing.push({ username: row.username, requestedAt: row.created_at });
      else out.incoming.push({ username: row.username, requestedAt: row.created_at });
    }
    res.json(out);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch friends' });
  }
});

// GET /api/friends/search?q= — username lookup. Prefix match for q of 2+ chars,
// exact match only for shorter q. Returns usernames + relationship status only.
router.get('/search', async (req, res) => {
  const q = normUsername(req.query.q);
  if (!q) return res.json([]);
  if (q.length > 64) return res.status(400).json({ error: 'query too long' });
  try {
    const pattern = q.length >= 2 ? escapeLike(q) + '%' : escapeLike(q);
    const r = await pool.query(
      `SELECT u.username, f.status, f.requester_id
         FROM users u
         LEFT JOIN friendships f
           ON (f.requester_id = $1 AND f.addressee_id = u.id)
           OR (f.addressee_id = $1 AND f.requester_id = u.id)
        WHERE u.id <> $1 AND u.username LIKE $2
        ORDER BY (u.username = $3) DESC, u.username ASC
        LIMIT ${SEARCH_LIMIT}`,
      [req.userId, pattern, q]
    );
    res.json(r.rows.map(row => ({
      username: row.username,
      status: !row.status ? 'none'
        : row.status === 'accepted' ? 'friends'
        : row.requester_id === req.userId ? 'outgoing' : 'incoming',
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// POST /api/friends/requests — body { username }. Sends a request. If that user
// already sent us one, this accepts it instead (both sides clearly want it).
router.post('/requests', async (req, res) => {
  const username = normUsername(req.body && req.body.username);
  if (!username) return res.status(400).json({ error: 'username required' });
  try {
    const otherId = await findUserId(username);
    if (!otherId) return res.status(404).json({ error: 'User not found' });
    if (otherId === req.userId) return res.status(400).json({ error: 'Cannot friend yourself' });

    const existing = await findFriendship(req.userId, otherId);
    if (existing) {
      if (existing.status === 'accepted') return res.status(409).json({ error: 'Already friends', status: 'friends' });
      if (existing.requester_id === req.userId) return res.status(409).json({ error: 'Request already sent', status: 'outgoing' });
      await pool.query(
        `UPDATE friendships SET status = 'accepted', accepted_at = NOW() WHERE id = $1 AND status = 'pending'`,
        [existing.id]
      );
      return res.json({ ok: true, status: 'friends' });
    }

    try {
      await pool.query(
        'INSERT INTO friendships (requester_id, addressee_id) VALUES ($1, $2)',
        [req.userId, otherId]
      );
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'Request already exists' }); // raced
      throw err;
    }
    res.json({ ok: true, status: 'outgoing' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send request' });
  }
});

// POST /api/friends/requests/:username/accept — accept an incoming request
router.post('/requests/:username/accept', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE friendships f SET status = 'accepted', accepted_at = NOW()
         FROM users u
        WHERE u.username = $2 AND f.requester_id = u.id
          AND f.addressee_id = $1 AND f.status = 'pending'`,
      [req.userId, normUsername(req.params.username)]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'No pending request' });
    res.json({ ok: true, status: 'friends' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to accept request' });
  }
});

// DELETE /api/friends/requests/:username — decline an incoming request or
// cancel an outgoing one. Only touches PENDING rows.
router.delete('/requests/:username', async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM friendships f
        USING users u
        WHERE u.username = $2 AND f.status = 'pending'
          AND ((f.requester_id = $1 AND f.addressee_id = u.id)
            OR (f.addressee_id = $1 AND f.requester_id = u.id))`,
      [req.userId, normUsername(req.params.username)]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'No pending request' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove request' });
  }
});

// DELETE /api/friends/:username — unfriend (either side may do it)
router.delete('/:username', async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM friendships f
        USING users u
        WHERE u.username = $2 AND f.status = 'accepted'
          AND ((f.requester_id = $1 AND f.addressee_id = u.id)
            OR (f.addressee_id = $1 AND f.requester_id = u.id))`,
      [req.userId, normUsername(req.params.username)]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'Not friends' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove friend' });
  }
});

// GET /api/friends/:username/sessions?before=&limit= — a friend's FINISHED
// sessions, newest first. 404 unless the two users are accepted friends.
router.get('/:username/sessions', async (req, res) => {
  const page = parsePage(req.query);
  if (page.error) return res.status(400).json({ error: page.error });
  try {
    const username = normUsername(req.params.username);
    const friendId = await acceptedFriendId(req.userId, username);
    if (!friendId) return res.status(404).json({ error: 'Not found' });

    const params = [friendId, page.limit + 1];
    let cursorSql = '';
    if (page.before) {
      params.push(page.before.ts, page.before.id);
      cursorSql = 'AND (s.finished_at, s.id) < ($3::timestamptz, $4)';
    }
    const r = await pool.query(
      `SELECT s.*, ${CURSOR_TS} AS cursor_ts
         FROM sessions s
        WHERE s.user_id = $1 AND s.finished_at IS NOT NULL ${cursorSql}
        ORDER BY s.finished_at DESC, s.id DESC
        LIMIT $2`,
      params
    );
    const body = await pageResponse(r.rows, page.limit);
    for (const it of body.items) it.username = username;
    res.json(body);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// GET /api/friends/:username/sessions/:id — one FINISHED session of a friend
router.get('/:username/sessions/:id', async (req, res) => {
  try {
    const username = normUsername(req.params.username);
    const friendId = await acceptedFriendId(req.userId, username);
    if (!friendId) return res.status(404).json({ error: 'Not found' });
    const r = await pool.query(
      'SELECT * FROM sessions WHERE id = $1 AND user_id = $2 AND finished_at IS NOT NULL',
      [req.params.id, friendId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const [session] = await hydrateSessions(r.rows);
    session.username = username;
    res.json(session);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});

module.exports = router;
