// Leaderboard integration tests against the REAL test database.
// Throwaway users are prefixed "zzlb_" and deleted afterwards (sessions cascade).
// Safety: they only run when DATABASE_URL names a *_test database.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const dbName = (() => {
  try { return new URL(process.env.DATABASE_URL).pathname.slice(1); } catch { return ''; }
})();
const skip = /_test$/.test(dbName) ? false : `DATABASE_URL is not a *_test database (got "${dbName}")`;

const request = require('supertest');
const pool = require('../src/db/pool');
const app = require('../src/app');
const { signToken } = require('../src/auth/tokens');
const { pointsBoard } = require('../src/routes/leaderboard');

const tag = Math.random().toString(36).slice(2, 8);
const U = {};   // key -> { id, username, token }
let seq = 0;

async function makeUser(key) {
  const username = `zzlb_${key}_${tag}`;
  const r = await pool.query("INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id", [username]);
  U[key] = { id: r.rows[0].id, username, token: signToken({ userId: r.rows[0].id, username }) };
}
async function befriend(a, b, status = 'accepted') {
  await pool.query(
    `INSERT INTO friendships (requester_id, addressee_id, status, accepted_at)
     VALUES ($1, $2, $3, CASE WHEN $3 = 'accepted' THEN NOW() END)`,
    [U[a].id, U[b].id, status]
  );
}
// lifts: [[exerciseName, reps, weight], ...]; finishedAt null = in progress
async function makeSession(key, finishedAt, lifts) {
  const id = `zzlb_${tag}_${++seq}`;
  const started = finishedAt ? new Date(new Date(finishedAt) - 3600e3) : new Date();
  await pool.query('INSERT INTO sessions (id, started_at, finished_at, user_id) VALUES ($1, $2, $3, $4)',
    [id, started, finishedAt, U[key].id]);
  const exIds = new Map();
  for (const [i, [name, reps, weight]] of lifts.entries()) {
    if (!exIds.has(name)) {
      const exId = `${id}_e${exIds.size}`;
      exIds.set(name, exId);
      await pool.query('INSERT INTO session_exercises (id, session_id, name, position) VALUES ($1, $2, $3, $4)',
        [exId, id, name, exIds.size]);
    }
    await pool.query('INSERT INTO sets (id, session_exercise_id, reps, weight, saved_at, position) VALUES ($1, $2, $3, $4, $5, $6)',
      [`${id}_s${i}`, exIds.get(name), reps, weight, finishedAt, i]);
  }
  return id;
}

const auth = (k) => ({ Authorization: `Bearer ${U[k].token}` });
const get = (k, url) => request(app).get(url).set(auth(k));
const names = (body) => body.entries.map(e => e.username);

describe('leaderboard (integration, real test DB)', { skip }, () => {
  before(async () => {
    await pool.query("DELETE FROM users WHERE username LIKE 'zzlb\\_%'");   // leftovers from a crashed run
    for (const k of ['alice', 'bob', 'v', 'f', 'g', 'p', 's', 'u']) await makeUser(k);
  });
  after(async () => {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [Object.values(U).map(u => u.id)]);
    await pool.end();
  });

  // ── Points math end to end, clock pinned ──────────────────────────────────
  // Week: Mon 2026-11-16 00:00 EST (05:00Z) – Mon 2026-11-23. Month: Nov 2026.
  describe('points with a pinned clock (America/New_York)', () => {
    const NOW = new Date('2026-11-21T20:00:00Z');   // Saturday afternoon
    const opts = { now: NOW, tz: 'America/New_York' };

    before(async () => {
      await befriend('alice', 'bob');
      // Monthly baseline only (Oct 15): OHP 5×100
      await makeSession('alice', '2026-10-15T15:00:00Z', [['Overhead Press', 5, 100]]);
      // Nov 2: weekly baseline, but inside the month. Lowercase name on purpose.
      await makeSession('alice', '2026-11-02T15:00:00Z',
        [['bench press', 5, 200], ['Deadlift', 5, 300], ['Overhead Press', 5, 100]]);
      // Sunday 23:30 EST (= Monday 04:30Z): belongs to LAST week
      await makeSession('alice', '2026-11-16T04:30:00Z', [['Leg Press', 10, 300]]);
      // Monday 00:30 EST: THIS week
      await makeSession('alice', '2026-11-16T05:30:00Z', [['Leg Press', 10, 310], ['Bench Press', 5, 205]]);
      // Wednesday, two sessions the same day
      await makeSession('alice', '2026-11-18T14:00:00Z', [
        ['Squat', 5, 225],                 // first time: 0
        ['Deadlift', 5, 400],              // +33%: ignored
        ['Overhead Press', 15, 100],       // >12 reps: excluded from e1RM
        ['Overhead Press', 5, 112],        // +12%
      ]);
      await makeSession('alice', '2026-11-18T15:00:00Z', [['Bench Press', 3, 100]]);
      // Empty finished workout: no consistency day
      await makeSession('alice', '2026-11-20T15:00:00Z', []);
      // In-progress: never counts
      await makeSession('alice', null, [['Bench Press', 5, 300]]);

      // bob: a workout every day Nov 1–21 (21 days; 6 this week)
      for (let d = 1; d <= 21; d++) {
        await makeSession('bob', `2026-11-${String(d).padStart(2, '0')}T17:00:00Z`, [['Squat', 5, 100]]);
      }
    });

    test('weekly: baseline/no-baseline, caps, 25% guard, reps > 12, Sunday/Monday boundary', async () => {
      const b = await pointsBoard(U.alice.id, 'week', opts);
      assert.strictEqual(b.start.toISOString(), '2026-11-16T05:00:00.000Z');
      assert.strictEqual(b.end.toISOString(), '2026-11-23T05:00:00.000Z');
      assert.strictEqual(b.startDate, '2026-11-16');
      assert.strictEqual(b.endDate, '2026-11-22');

      const alice = b.entries.find(e => e.username === U.alice.username);
      const ex = Object.fromEntries(alice.exercises.map(x => [x.name, x]));
      // case-insensitive: "bench press" (baseline) + "Bench Press" (this week) are one exercise
      assert.deepStrictEqual(Object.keys(ex).sort(),
        ['Bench Press', 'Deadlift', 'Leg Press', 'Overhead Press', 'Squat']);
      assert.strictEqual(ex['Bench Press'].points, 25);          // +2.5%
      assert.strictEqual(ex['Bench Press'].pct, 2.5);
      assert.strictEqual(ex['Bench Press'].baseline, 233.3);
      assert.strictEqual(ex['Bench Press'].best, 239.2);
      // Sunday 23:30 local session is the baseline (last week), Monday 00:30 is this week
      assert.strictEqual(ex['Leg Press'].baseline, 400);
      assert.strictEqual(ex['Leg Press'].best, 413.3);
      assert.strictEqual(ex['Leg Press'].points, 33);
      assert.deepStrictEqual([ex.Squat.points, ex.Squat.status], [0, 'new']);
      assert.deepStrictEqual([ex.Deadlift.points, ex.Deadlift.status], [0, 'ignored']);
      // 15×100 would be e1RM 150 (+28%, ignored); only 5×112 counts: +12% → capped at 50
      assert.strictEqual(ex['Overhead Press'].best, 130.7);
      assert.deepStrictEqual([ex['Overhead Press'].points, ex['Overhead Press'].status], [50, 'capped']);
      // days: Monday + Wednesday (twice) = 2. Not Sunday, not the empty Friday one.
      assert.deepStrictEqual(alice.consistency, { days: 2, countedDays: 2, points: 20 });
      assert.strictEqual(alice.total, 25 + 33 + 50 + 20);
      assert.deepStrictEqual([alice.progressRaw, alice.progress, alice.progressCapped], [108, 108, false]);
      assert.strictEqual(b.rules.progressTotalCap, 150);
      assert.strictEqual(b.rules.crownMaxJumpPct, 50);

      const bob = b.entries.find(e => e.username === U.bob.username);
      assert.deepStrictEqual(bob.consistency, { days: 6, countedDays: 4, points: 40 });
      assert.strictEqual(bob.exercises[0].status, 'no-gain');
      assert.deepStrictEqual(b.entries.map(e => [e.rank, e.username]),
        [[1, U.alice.username], [2, U.bob.username]]);
    });

    test('monthly: 100 cap, 16-day cap, baseline is the 8 weeks before the 1st', async () => {
      const b = await pointsBoard(U.alice.id, 'month', opts);
      assert.strictEqual(b.start.toISOString(), '2026-11-01T04:00:00.000Z');   // EDT until Nov 1 02:00
      assert.strictEqual(b.end.toISOString(), '2026-12-01T05:00:00.000Z');
      const alice = b.entries.find(e => e.username === U.alice.username);
      const ex = Object.fromEntries(alice.exercises.map(x => [x.name, x]));
      // Oct 15 baseline 116.7 → 130.7 = +12% → 120 → capped at 100
      assert.deepStrictEqual([ex['Overhead Press'].points, ex['Overhead Press'].status], [100, 'capped']);
      // Bench and Leg Press first appear in November: no baseline before the month
      assert.strictEqual(ex['Bench Press'].status, 'new');
      assert.strictEqual(ex['Leg Press'].status, 'new');
      // local days: Nov 2, Nov 15 (the Sun 23:30 one), Nov 16, Nov 18
      assert.strictEqual(alice.consistency.days, 4);
      const bob = b.entries.find(e => e.username === U.bob.username);
      assert.deepStrictEqual(bob.consistency, { days: 21, countedDays: 16, points: 160 });
    });

    test('offset -1 is the previous week', async () => {
      const b = await pointsBoard(U.alice.id, 'week', { ...opts, offset: -1 });
      assert.strictEqual(b.startDate, '2026-11-09');
      assert.strictEqual(b.endDate, '2026-11-15');
      const alice = b.entries.find(e => e.username === U.alice.username);
      assert.deepStrictEqual(alice.exercises.map(x => x.name), ['Leg Press']);   // the Sunday 23:30 one
      assert.strictEqual(alice.consistency.days, 1);
    });
  });

  // ── Authorization + strength, real clock via HTTP ─────────────────────────
  describe('authorization and strength board (HTTP)', () => {
    const t = (minAgo) => new Date(Date.now() - minAgo * 60e3).toISOString();

    before(async () => {
      await befriend('v', 'f');
      await befriend('g', 'v');            // accepted, other direction
      await befriend('v', 'p', 'pending'); // pending: excluded both ways
      await befriend('u', 'v');            // unfriended in a test below
      // s is a stranger

      // Bench: G 200×5 first, F 200×5 later, V 200×3 → G, F, V
      await makeSession('v', t(10), [['Bench Press', 3, 180]]);   // backs up the 200 (crown guard)
      await makeSession('v', t(3), [['Bench Press', 3, 200]]);
      await makeSession('g', t(9), [['bench press', 5, 180]]);
      await makeSession('g', t(5), [['bench press', 5, 200]]);
      await makeSession('f', t(6), [['Bench Press', 10, 180]]);
      await makeSession('f', t(2), [['Bench Press', 5, 200]]);
      await makeSession('f', null, [['Bench Press', 1, 500]]);       // in progress: excluded
      await makeSession('p', t(2), [['Bench Press', 1, 400], ['Pending Only Lift', 5, 50]]);
      await makeSession('s', t(2), [['Bench Press', 1, 450], ['Stranger Only Lift', 5, 50]]);
      await makeSession('u', t(7), [['Bench Press', 1, 140]]);
      await makeSession('u', t(2), [['Bench Press', 1, 150]]);
      await makeSession('g', null, [['Active Only Lift', 5, 50]]);   // in progress
      // High-rep set: holder, but no e1RM shown
      await makeSession('g', t(8), [['Leg Press', 15, 280]]);
      await makeSession('g', t(4), [['Leg Press', 15, 300]]);
    });

    test('require a token', async () => {
      for (const p of ['weekly', 'monthly', 'strength', 'strength/squat']) {
        assert.strictEqual((await request(app).get(`/api/leaderboard/${p}`)).status, 401);
      }
    });

    test('weekly/monthly: only viewer + accepted friends; pending and strangers excluded', async () => {
      for (const p of ['weekly', 'monthly']) {
        const r = await get('v', `/api/leaderboard/${p}`);
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(names(r.body).sort(),
          [U.f.username, U.g.username, U.u.username, U.v.username].sort());
        assert.strictEqual(r.body.hasFriends, true);
        assert.strictEqual(r.body.entries.filter(e => e.isYou).length, 1);
        assert.strictEqual(r.body.entries.find(e => e.isYou).username, U.v.username);
      }
      // the pending side sees only themselves
      const p = await get('p', '/api/leaderboard/weekly');
      assert.deepStrictEqual(names(p.body), [U.p.username]);
      assert.strictEqual(p.body.hasFriends, false);
    });

    test('in-progress sessions do not count for points or days', async () => {
      const r = await get('f', '/api/leaderboard/weekly');
      const f = r.body.entries.find(e => e.isYou);
      assert.strictEqual(f.consistency.days, 1);
      assert.ok(f.exercises.every(x => x.best < 300));
    });

    test('offset validation', async () => {
      assert.strictEqual((await get('v', '/api/leaderboard/weekly?offset=1')).status, 400);
      assert.strictEqual((await get('v', '/api/leaderboard/weekly?offset=abc')).status, 400);
      const r = await get('v', '/api/leaderboard/monthly?offset=-1');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.offset, -1);
    });

    test('strength list: holders, friends only, finished only, numbers not strings', async () => {
      const r = await get('v', '/api/leaderboard/strength');
      assert.strictEqual(r.status, 200);
      const byName = Object.fromEntries(r.body.exercises.map(x => [x.name.toLowerCase(), x]));
      assert.ok(!byName['pending only lift']);
      assert.ok(!byName['stranger only lift']);
      assert.ok(!byName['active only lift']);
      const bench = byName['bench press'];
      assert.strictEqual(bench.name, 'Bench Press');            // library spelling
      assert.strictEqual(bench.holder.username, U.g.username);  // 200×5, first
      assert.strictEqual(bench.holder.weight, 200);
      assert.strictEqual(typeof bench.holder.weight, 'number');
      assert.strictEqual(bench.holder.reps, 5);
      assert.strictEqual(bench.holder.e1rm, 233.3);
      assert.strictEqual(bench.people, 4);                       // v, f, g, u
      assert.strictEqual(byName['leg press'].holder.e1rm, null); // 15 reps
    });

    test('strength detail: weight → reps → first; case-insensitive lookup; 404s', async () => {
      const r = await get('v', '/api/leaderboard/strength/BENCH%20PRESS');
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.body.entries.map(e => [e.rank, e.username, e.weight, e.reps]), [
        [1, U.g.username, 200, 5],
        [2, U.f.username, 200, 5],
        [3, U.v.username, 200, 3],
        [4, U.u.username, 150, 1],
      ]);
      assert.strictEqual(r.body.entries[2].isYou, true);
      assert.strictEqual((await get('v', '/api/leaderboard/strength/Stranger%20Only%20Lift')).status, 404);
      assert.strictEqual((await get('v', '/api/leaderboard/strength/Active%20Only%20Lift')).status, 404);
      assert.strictEqual((await get('v', '/api/leaderboard/strength/Pending%20Only%20Lift')).status, 404);
    });

    test('unfriending removes the user from every board', async () => {
      const del = await request(app).delete(`/api/friends/${U.u.username}`).set(auth('v'));
      assert.strictEqual(del.status, 200);
      assert.ok(!names((await get('v', '/api/leaderboard/weekly')).body).includes(U.u.username));
      assert.ok(!names((await get('v', '/api/leaderboard/monthly')).body).includes(U.u.username));
      const s = await get('v', '/api/leaderboard/strength/bench%20press');
      assert.ok(!s.body.entries.some(e => e.username === U.u.username));
      // and v disappears from u's board too
      assert.deepStrictEqual(names((await get('u', '/api/leaderboard/weekly')).body), [U.u.username]);
    });

    test('crown guard is per WORKOUT: repeated typo sets, lone workouts, backed-up PRs', async () => {
      // Overhead Press: f's two workouts agree (100, 105) → verified.
      // g types 1000 for every set of ONE workout (next to a real 110 set) → that
      // workout's best is 1000 and no other workout backs it: unverified, g unranked.
      await makeSession('f', t(12), [['Overhead Press', 5, 100]]);
      await makeSession('f', t(2), [['Overhead Press', 5, 105]]);
      await makeSession('g', t(2), [['Overhead Press', 5, 110], ['Overhead Press', 5, 1000],
        ['Overhead Press', 5, 1000], ['Overhead Press', 5, 1000]]);
      let r = (await get('v', '/api/leaderboard/strength/overhead%20press')).body;
      assert.deepStrictEqual(r.entries.map(e => [e.rank, e.username, e.weight]), [[1, U.f.username, 105]]);
      assert.deepStrictEqual(r.unverified.map(e => [e.username, e.weight, e.unverified]), [[U.g.username, 1000, true]]);
      assert.strictEqual(r.crownMaxJumpPct, 50);

      // Front Squat: v's only workout → no holder yet
      await makeSession('v', t(2), [['Front Squat', 3, 150], ['Front Squat', 3, 150]]);
      const list = (await get('v', '/api/leaderboard/strength')).body;
      const fs = list.exercises.find(x => x.name === 'Front Squat');
      assert.strictEqual(fs.holder, null);
      assert.strictEqual(fs.unverified, 1);

      // a second workout exactly 50% lighter backs it up
      await makeSession('v', t(1), [['Front Squat', 3, 100]]);
      r = (await get('v', '/api/leaderboard/strength/front%20squat')).body;
      assert.deepStrictEqual(r.entries.map(e => [e.username, e.weight]), [[U.v.username, 150]]);
      assert.deepStrictEqual(r.unverified, []);

      // a genuine big lift counts once another workout backs it: g logs 700 later
      await makeSession('g', t(0.5), [['Overhead Press', 5, 700]]);
      r = (await get('v', '/api/leaderboard/strength/overhead%20press')).body;
      assert.deepStrictEqual(r.entries.map(e => [e.username, e.weight]), [[U.g.username, 1000], [U.f.username, 105]]);
      assert.deepStrictEqual(r.unverified, []);
    });

    test('crown guard: 9999 / 2250 typo workouts with real 225s → the 225 holds', async () => {
      await makeSession('f', t(20), [['Hack Squat', 5, 225]]);
      await makeSession('f', t(19), [['Hack Squat', 5, 220]]);
      await makeSession('f', t(18), [['Hack Squat', 5, 2250], ['Hack Squat', 5, 2250]]);
      await makeSession('f', t(17), [['Hack Squat', 5, 9999]]);
      const r = (await get('v', '/api/leaderboard/strength/hack%20squat')).body;
      assert.deepStrictEqual(r.entries.map(e => [e.rank, e.username, e.weight]), [[1, U.f.username, 225]]);
      assert.deepStrictEqual(r.unverified.map(e => e.weight), [9999, 2250]);
      const holder = (await get('v', '/api/leaderboard/strength')).body.exercises.find(x => x.name === 'Hack Squat').holder;
      assert.deepStrictEqual([holder.username, holder.weight], [U.f.username, 225]);
    });
  });
});
