const router = require('express').Router();
const pool = require('../db/pool');
const { toWeight } = require('../db/hydrate');
const P = require('../leaderboard/points');

// All routes here are mounted behind requireAuth, so req.userId is the viewer.
// A board only ever contains the viewer and their ACCEPTED friends (pending
// requests and strangers never appear), and only FINISHED sessions count —
// the same rules as /api/feed and /api/friends/:username/sessions.

// $1 = viewer id. The viewer plus every accepted friend, either direction.
const BOARD_CTE = `
  board AS (
    SELECT $1::int AS id
    UNION
    SELECT CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
      FROM friendships f
     WHERE f.status = 'accepted' AND (f.requester_id = $1 OR f.addressee_id = $1)
  )`;

const MAX_OFFSET = 520;   // ~10 years of weeks; anything sane fits

function parseOffset(q) {
  if (q === undefined || q === '') return { offset: 0 };
  if (!/^-?\d+$/.test(String(q))) return { error: 'offset must be a whole number <= 0' };
  const n = Number(q);
  if (n > 0 || n < -MAX_OFFSET) return { error: `offset must be between -${MAX_OFFSET} and 0` };
  return { offset: n };
}

// Period bounds in the configured timezone. Local midnight → timestamptz is
// done by Postgres, so DST changes are handled. Dates are the local calendar
// days the period covers (endDate inclusive).
async function periodBounds(period, offset, now, tz) {
  const r = await pool.query(
    `WITH b AS (
       SELECT date_trunc($1, $3::timestamptz AT TIME ZONE $4) + $2::int * ('1 ' || $1)::interval AS ls
     )
     SELECT ls AT TIME ZONE $4                                      AS start,
            (ls + ('1 ' || $1)::interval) AT TIME ZONE $4            AS "end",
            (ls - make_interval(weeks => $5)) AT TIME ZONE $4        AS baseline_start,
            to_char(ls, 'YYYY-MM-DD')                                 AS start_date,
            to_char(ls + ('1 ' || $1)::interval - interval '1 day', 'YYYY-MM-DD') AS end_date
       FROM b`,
    [period, offset, now, tz, P.BASELINE_WEEKS]
  );
  return r.rows[0];
}

// The whole points board for one viewer and period. `now` and `tz` are
// injectable so tests can pin the clock and zone.
async function pointsBoard(viewerId, period, { offset = 0, now = new Date(), tz = P.TIMEZONE } = {}) {
  const bounds = await periodBounds(period, offset, now, tz);

  const usersRes = await pool.query(
    `WITH ${BOARD_CTE}
     SELECT u.id, u.username FROM board JOIN users u ON u.id = board.id`,
    [viewerId]
  );

  // Best e1RM per user per exercise (case-insensitive) in the period, and in
  // the baseline window before it. Only exercises done IN the period come back.
  // done_before: a set that would count was logged before the baseline window
  // (tells "back after 8+ weeks" apart from a real first time).
  const liftsRes = await pool.query(
    `WITH ${BOARD_CTE},
     lifts AS (
       SELECT s.user_id, lower(se.name) AS key, se.name, s.finished_at,
              s.finished_at >= $2 AS in_period,
              st.weight * (1 + st.reps / 30.0) AS e1rm
         FROM sessions s
         JOIN session_exercises se ON se.session_id = s.id
         JOIN sets st ON st.session_exercise_id = se.id
        WHERE s.user_id IN (SELECT id FROM board)
          AND s.finished_at IS NOT NULL
          AND s.finished_at >= $4 AND s.finished_at < $3
          AND st.reps BETWEEN $5 AND $6
          AND st.weight > 0
     )
     SELECT l.user_id, l.key,
            COALESCE(ex.name, (array_agg(l.name ORDER BY l.finished_at DESC))[1]) AS name,
            max(l.e1rm) FILTER (WHERE l.in_period)     AS best,
            max(l.e1rm) FILTER (WHERE NOT l.in_period) AS baseline,
            EXISTS (
              SELECT 1 FROM sessions s2
                JOIN session_exercises se2 ON se2.session_id = s2.id
                JOIN sets st2 ON st2.session_exercise_id = se2.id
               WHERE s2.user_id = l.user_id AND lower(se2.name) = l.key
                 AND s2.finished_at IS NOT NULL AND s2.finished_at < $4
                 AND st2.reps BETWEEN $5 AND $6 AND st2.weight > 0
            ) AS done_before
       FROM lifts l
       LEFT JOIN exercises ex ON lower(ex.name) = l.key
      GROUP BY l.user_id, l.key, ex.name
     HAVING bool_or(l.in_period)`,
    [viewerId, bounds.start, bounds.end, bounds.baseline_start, P.E1RM_MIN_REPS, P.E1RM_MAX_REPS]
  );

  // Distinct local calendar days with a finished workout that logged at least
  // one set with reps (an empty "start → finish" doesn't count).
  const daysRes = await pool.query(
    `WITH ${BOARD_CTE}
     SELECT s.user_id, count(DISTINCT (s.finished_at AT TIME ZONE $4)::date)::int AS days
       FROM sessions s
      WHERE s.user_id IN (SELECT id FROM board)
        AND s.finished_at IS NOT NULL
        AND s.finished_at >= $2 AND s.finished_at < $3
        AND EXISTS (SELECT 1 FROM session_exercises se JOIN sets st ON st.session_exercise_id = se.id
                     WHERE se.session_id = s.id AND st.reps >= 1)
      GROUP BY s.user_id`,
    [viewerId, bounds.start, bounds.end, tz]
  );

  const entries = P.buildBoard({
    users: usersRes.rows,
    lifts: liftsRes.rows.map(r => ({
      userId: r.user_id, name: r.name,
      best: Number(r.best),
      baseline: r.baseline === null ? null : Number(r.baseline),
      doneBefore: r.done_before === true,
    })),
    days: new Map(daysRes.rows.map(r => [r.user_id, r.days])),
    period,
    viewerId,
  });

  return {
    period,
    offset,
    timezone: tz,
    start: bounds.start,
    end: bounds.end,
    startDate: bounds.start_date,
    endDate: bounds.end_date,
    hasFriends: usersRes.rows.length > 1,
    rules: {
      progressCap: P.PROGRESS_CAP[period],
      progressTotalCap: P.PROGRESS_TOTAL_CAP[period],
      crownMaxJumpPct: P.CROWN_MAX_JUMP_PCT,
      daysCap: P.DAYS_CAP[period],
      pointsPerDay: P.POINTS_PER_DAY,
      pointsPerPercent: P.POINTS_PER_PERCENT,
      maxGainPct: P.MAX_PLAUSIBLE_GAIN_PCT,
      baselineWeeks: P.BASELINE_WEEKS,
      maxReps: P.E1RM_MAX_REPS,
    },
    entries,
  };
}

// Each board member's best lift PER WORKOUT for each exercise (all-time,
// finished workouts, weight > 0, reps >= 1): heaviest → more reps. The crown
// guard compares these across workouts. `key` (lowercased name) narrows it to
// one exercise.
async function strengthRows(viewerId, key) {
  const params = [viewerId];
  let keySql = '';
  if (key !== undefined) { params.push(key); keySql = 'AND lower(se.name) = $2'; }
  const r = await pool.query(
    `WITH ${BOARD_CTE},
     per_session AS (
       SELECT DISTINCT ON (lower(se.name), s.id)
              lower(se.name) AS key, se.name, s.user_id, s.id AS session_id,
              st.weight, st.reps, s.finished_at, (s.edited_at IS NOT NULL) AS edited
         FROM sessions s
         JOIN session_exercises se ON se.session_id = s.id
         JOIN sets st ON st.session_exercise_id = se.id
        WHERE s.user_id IN (SELECT id FROM board)
          AND s.finished_at IS NOT NULL
          AND st.weight > 0 AND st.reps >= 1 ${keySql}
        ORDER BY lower(se.name), s.id, st.weight DESC, st.reps DESC, st.id ASC
     )
     SELECT p.key, COALESCE(ex.name, p.name) AS name, u.id AS user_id, u.username,
            p.session_id, p.weight, p.reps, p.finished_at, p.edited
       FROM per_session p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN exercises ex ON lower(ex.name) = p.key
      ORDER BY p.key, p.user_id, p.weight DESC, p.reps DESC, p.finished_at ASC`,
    params
  );
  return r.rows.map(row => ({
    key: row.key, name: row.name, userId: row.user_id, username: row.username,
    sessionId: row.session_id, weight: toWeight(row.weight),
    reps: row.reps, date: row.finished_at, edited: row.edited === true,
  }));
}

// rows (from strengthRows) grouped per exercise key, in first-seen order.
function groupByKey(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.key)) m.set(r.key, { key: r.key, name: r.name, rows: [] });
    m.get(r.key).rows.push(r);
  }
  return [...m.values()];
}

function strengthEntry(l, viewerId, extra = {}) {
  return {
    ...(l.rank !== undefined ? { rank: l.rank } : {}),
    username: l.username,
    isYou: l.userId === viewerId,
    weight: l.weight,
    reps: l.reps,
    // e1RM is shown as extra info only; it's meaningless past 12 reps.
    e1rm: l.reps <= P.E1RM_MAX_REPS ? P.round1(P.e1rm(l.weight, l.reps)) : null,
    date: l.date,
    edited: l.edited,   // PR comes from a workout edited after finishing
    ...extra,
  };
}

async function hasFriends(viewerId) {
  const r = await pool.query(
    `SELECT 1 FROM friendships
      WHERE status = 'accepted' AND (requester_id = $1 OR addressee_id = $1) LIMIT 1`,
    [viewerId]
  );
  return r.rows.length > 0;
}

// ── Routes ───────────────────────────────────────────────────────────────────

for (const [path, period] of [['/weekly', 'week'], ['/monthly', 'month']]) {
  router.get(path, async (req, res) => {
    const o = parseOffset(req.query.offset);
    if (o.error) return res.status(400).json({ error: o.error });
    try {
      res.json(await pointsBoard(req.userId, period, { offset: o.offset }));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to load leaderboard' });
    }
  });
}

// GET /api/leaderboard/strength — one row per exercise anyone on the board has
// done, with its current holder (null if every top lift is still unverified).
router.get('/strength', async (req, res) => {
  try {
    const out = groupByKey(await strengthRows(req.userId)).map(g => {
      const { ranked, unverified } = P.strengthStandings(g.rows);
      return {
        name: g.name,
        holder: ranked.length ? strengthEntry(ranked[0], req.userId) : null,
        people: new Set(g.rows.map(r => r.userId)).size,
        unverified: unverified.length,
      };
    });
    out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    res.json({
      hasFriends: await hasFriends(req.userId),
      crownMaxJumpPct: P.CROWN_MAX_JUMP_PCT,
      exercises: out,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load leaderboard' });
  }
});

// GET /api/leaderboard/strength/:exercise — everyone's best verified lift for
// one exercise, ranked, plus top lifts held back by the crown guard
// (`unverified`, not ranked). Name matched ignoring case; 404 if nobody on the
// board has done it.
router.get('/strength/:exercise', async (req, res) => {
  const key = String(req.params.exercise || '').trim().toLowerCase();
  if (!key || key.length > 200) return res.status(400).json({ error: 'exercise required' });
  try {
    const rows = await strengthRows(req.userId, key);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const { ranked, unverified } = P.strengthStandings(rows);
    res.json({
      name: rows[0].name,
      crownMaxJumpPct: P.CROWN_MAX_JUMP_PCT,
      entries: ranked.map(l => strengthEntry(l, req.userId)),
      unverified: unverified.map(l => strengthEntry(l, req.userId, { unverified: true })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load leaderboard' });
  }
});

module.exports = router;
module.exports.pointsBoard = pointsBoard;
