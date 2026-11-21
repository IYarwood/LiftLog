const router = require('express').Router();
const pool = require('../db/pool');
const { parsePage, pageResponse, CURSOR_TS } = require('../db/paging');

// GET /api/feed?before=&limit= — FINISHED sessions of all accepted friends,
// newest first, each tagged with the friend's username. Keyset-paginated.
router.get('/', async (req, res) => {
  const page = parsePage(req.query);
  if (page.error) return res.status(400).json({ error: page.error });
  try {
    const params = [req.userId, page.limit + 1];
    let cursorSql = '';
    if (page.before) {
      params.push(page.before.ts, page.before.id);
      cursorSql = 'AND (s.finished_at, s.id) < ($3::timestamptz, $4)';
    }
    const r = await pool.query(
      `SELECT s.*, u.username, ${CURSOR_TS} AS cursor_ts
         FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
         JOIN sessions s ON s.user_id = u.id
        WHERE f.status = 'accepted'
          AND (f.requester_id = $1 OR f.addressee_id = $1)
          AND s.finished_at IS NOT NULL ${cursorSql}
        ORDER BY s.finished_at DESC, s.id DESC
        LIMIT $2`,
      params
    );
    res.json(await pageResponse(r.rows, page.limit));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch feed' });
  }
});

module.exports = router;
