// Integration tests for exercises inside a session, against the REAL test DB:
// one-exercise-per-session (case-insensitive 409), idempotent re-sends,
// numeric weights, and stable exercise/set order after removals.
// Every row this file creates belongs to a "zzsx_" user and is removed
// afterwards (sessions/exercises/sets cascade from the user).
// Safety: only runs when DATABASE_URL points at a database whose name ends in
// "_test" (e.g. liftlog_test) and is skipped otherwise — never against prod.
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

const tag = Math.random().toString(36).slice(2, 8);
const ID = (s) => `zzsx_${tag}_${s}`;
let token;
let seq = 0;

const authed = (r) => r.set('Authorization', `Bearer ${token}`);
async function newSession() {
  const id = ID('sess' + (++seq));
  const res = await authed(request(app).post('/api/sessions')).send({ id, startedAt: new Date().toISOString() });
  assert.strictEqual(res.status, 200);
  return id;
}
const addEx = (sid, id, name, position = 0) =>
  authed(request(app).post(`/api/sessions/${sid}/exercises`)).send({ id, name, position });
const getSession = async (sid) => {
  const res = await authed(request(app).get(`/api/sessions/${sid}`));
  assert.strictEqual(res.status, 200);
  return res.body;
};

async function cleanup() {
  await pool.query("DELETE FROM users WHERE username LIKE 'zzsx\\_%'");
}

describe('session exercises (integration, real test DB)', { skip }, () => {
  before(async () => {
    await cleanup();
    const u = await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id", [`zzsx_user_${tag}`]
    );
    token = signToken({ userId: u.rows[0].id, username: `zzsx_user_${tag}` });
  });

  after(async () => {
    await cleanup();
    await pool.end();
  });

  test('adding the same name twice to one session → 409 with the existing entry', async () => {
    const sid = await newSession();
    assert.strictEqual((await addEx(sid, ID('a1'), 'Squat')).status, 200);
    const res = await addEx(sid, ID('a2'), 'Squat');
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.id, ID('a1'));
    assert.strictEqual(res.body.name, 'Squat');
    assert.deepStrictEqual((await getSession(sid)).exercises.map(e => e.name), ['Squat']);
  });

  test('the duplicate check ignores case and surrounding whitespace', async () => {
    const sid = await newSession();
    assert.strictEqual((await addEx(sid, ID('b1'), 'Bench Press')).status, 200);
    const res = await addEx(sid, ID('b2'), '  bench PRESS ');
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.name, 'Bench Press');
    assert.strictEqual((await getSession(sid)).exercises.length, 1);
  });

  test('the same name in a different session is fine', async () => {
    const s1 = await newSession();
    const s2 = await newSession();
    assert.strictEqual((await addEx(s1, ID('c1'), 'Deadlift')).status, 200);
    assert.strictEqual((await addEx(s2, ID('c2'), 'Deadlift')).status, 200);
  });

  test('re-sending the exact same add (same id + name) is idempotent → 200, one row', async () => {
    const sid = await newSession();
    assert.strictEqual((await addEx(sid, ID('d1'), 'Row')).status, 200);
    const again = await addEx(sid, ID('d1'), 'Row');
    assert.strictEqual(again.status, 200);
    assert.deepStrictEqual(again.body, { ok: true, id: ID('d1') });
    assert.strictEqual((await getSession(sid)).exercises.length, 1);
  });

  test('reusing an id for a different exercise → 409, nothing changes', async () => {
    const sid = await newSession();
    assert.strictEqual((await addEx(sid, ID('e1'), 'Curl')).status, 200);
    const res = await addEx(sid, ID('e1'), 'Shrug');
    assert.strictEqual(res.status, 409);
    assert.deepStrictEqual((await getSession(sid)).exercises.map(e => e.name), ['Curl']);
  });

  test('after removing an exercise it can be added again', async () => {
    const sid = await newSession();
    assert.strictEqual((await addEx(sid, ID('f1'), 'Dip')).status, 200);
    assert.strictEqual((await authed(request(app).delete(`/api/sessions/${sid}/exercises/${ID('f1')}`))).status, 200);
    assert.strictEqual((await addEx(sid, ID('f2'), 'dip')).status, 200);
  });

  test('concurrent adds of the same name → exactly one wins', async () => {
    const sid = await newSession();
    const results = await Promise.all(
      [1, 2, 3, 4].map(i => addEx(sid, ID('g' + i), i % 2 ? 'Lunge' : 'LUNGE'))
    );
    assert.deepStrictEqual(results.map(r => r.status).sort(), [200, 409, 409, 409]);
    assert.strictEqual((await getSession(sid)).exercises.length, 1);
  });

  test('weights come back as numbers without trailing zeros', async () => {
    const sid = await newSession();
    assert.strictEqual((await addEx(sid, ID('w1'), 'Press')).status, 200);
    const weights = [225, 225.5, 102.25, null];
    for (const [i, w] of weights.entries()) {
      const setId = ID('ws' + i);
      await authed(request(app).post(`/api/sessions/${sid}/exercises/${ID('w1')}/sets`)).send({ id: setId, position: i });
      if (w !== null) {
        await authed(request(app).patch(`/api/sessions/${sid}/exercises/${ID('w1')}/sets/${setId}`)).send({ reps: 5, weight: w });
      }
    }
    const sess = await getSession(sid);
    assert.deepStrictEqual(sess.exercises[0].sets.map(s => s.weight), weights);
    // Same shape from the shared hydrator used by the feed and friend history
    const { hydrateSessions } = require('../src/db/hydrate');
    const row = (await pool.query('SELECT * FROM sessions WHERE id = $1', [sid])).rows[0];
    const [h] = await hydrateSessions([row]);
    assert.deepStrictEqual(h.exercises[0].sets.map(s => s.weight), weights);
  });

  const names = async (sid) => (await getSession(sid)).exercises.map(e => e.name);
  const delEx = (sid, exId) => authed(request(app).delete(`/api/sessions/${sid}/exercises/${exId}`));

  test('removing exercises never lets a new one jump ahead (positions are MAX + 1)', async () => {
    const sid = await newSession();
    // The old client sent position = its current count, which repeats after a
    // removal; the server must ignore it.
    await addEx(sid, ID('o1'), 'A', 0);
    await addEx(sid, ID('o2'), 'B', 1);
    await addEx(sid, ID('o3'), 'C', 2);
    await delEx(sid, ID('o1'));
    await delEx(sid, ID('o2'));
    await addEx(sid, ID('o4'), 'D', 1);   // stale client position 1 < C's 2
    await addEx(sid, ID('o5'), 'E', 0);
    assert.deepStrictEqual(await names(sid), ['C', 'D', 'E']);
    const pos = (await pool.query(
      'SELECT name, position FROM session_exercises WHERE session_id = $1 ORDER BY position', [sid]
    )).rows;
    assert.deepStrictEqual(pos.map(r => r.position), [2, 3, 4]);
  });

  test('order is stable across reloads even when legacy rows share a position', async () => {
    const sid = await newSession();
    // Legacy data written by the old client: equal positions, inserted in order.
    for (const [i, n] of ['P', 'Q', 'R', 'S'].entries()) {
      await pool.query(
        `INSERT INTO session_exercises (id, session_id, name, position, created_at)
         VALUES ($1, $2, $3, 1, NOW() + ($4 || ' seconds')::interval)`,
        [ID('leg' + i), sid, n, String(i)]
      );
    }
    for (let k = 0; k < 5; k++) assert.deepStrictEqual(await names(sid), ['P', 'Q', 'R', 'S']);
    const { hydrateSessions } = require('../src/db/hydrate');
    const row = (await pool.query('SELECT * FROM sessions WHERE id = $1', [sid])).rows[0];
    assert.deepStrictEqual((await hydrateSessions([row]))[0].exercises.map(e => e.name), ['P', 'Q', 'R', 'S']);
  });

  test('sets keep their order after removals too', async () => {
    const sid = await newSession();
    await addEx(sid, ID('so'), 'Squat');
    const base = `/api/sessions/${sid}/exercises/${ID('so')}/sets`;
    for (const i of [0, 1, 2]) await authed(request(app).post(base)).send({ id: ID('set' + i), position: i });
    await authed(request(app).delete(`${base}/${ID('set0')}`));
    await authed(request(app).delete(`${base}/${ID('set1')}`));
    await authed(request(app).post(base)).send({ id: ID('set3'), position: 1 });   // stale position
    const sets = (await getSession(sid)).exercises[0].sets.map(s => s.id);
    assert.deepStrictEqual(sets, [ID('set2'), ID('set3')]);
  });

  test('set values the columns cannot hold are a 400, not a 500, and change nothing', async () => {
    const sid = await newSession();
    await addEx(sid, ID('v1'), 'Calf Raise');
    const base = `/api/sessions/${sid}/exercises/${ID('v1')}/sets`;
    await authed(request(app).post(base)).send({ id: ID('vs') });
    const patch = (body) => authed(request(app).patch(`${base}/${ID('vs')}`)).send(body);
    assert.strictEqual((await patch({ reps: 5, weight: 9999.99 })).status, 200);
    assert.strictEqual((await patch({ weight: 12345 })).status, 400);
    assert.strictEqual((await patch({ reps: 1.5 })).status, 400);
    assert.strictEqual((await patch({ reps: '7' })).status, 200);   // weight omitted = unchanged
    const [set] = (await getSession(sid)).exercises[0].sets;
    assert.strictEqual(set.reps, 7);
    assert.strictEqual(set.weight, 9999.99);
  });

  test('PATCH set: explicit null clears a field, an omitted field is kept', async () => {
    const sid = await newSession();
    await addEx(sid, ID('n1'), 'Shrug');
    const base = `/api/sessions/${sid}/exercises/${ID('n1')}/sets`;
    await authed(request(app).post(base)).send({ id: ID('ns') });
    const patch = (body) => authed(request(app).patch(`${base}/${ID('ns')}`)).send(body);
    const set = async () => (await getSession(sid)).exercises[0].sets[0];

    assert.strictEqual((await patch({ reps: 8, weight: 1234 })).status, 200);
    assert.strictEqual((await patch({ reps: 9 })).status, 200);               // weight omitted
    assert.deepStrictEqual([(await set()).reps, (await set()).weight], [9, 1234]);
    assert.strictEqual((await patch({ weight: null })).status, 200);          // clear weight only
    assert.deepStrictEqual([(await set()).reps, (await set()).weight], [9, null]);
    assert.strictEqual((await patch({ reps: '' })).status, 200);              // blank input clears too
    assert.deepStrictEqual([(await set()).reps, (await set()).weight], [null, null]);
    assert.strictEqual((await patch({})).status, 200);                        // nothing to change
    assert.deepStrictEqual([(await set()).reps, (await set()).weight], [null, null]);
  });

  test("another user's session → 404", async () => {
    const other = await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id", [`zzsx_other_${tag}`]
    );
    const sid = ID('foreign');
    await pool.query('INSERT INTO sessions (id, started_at, user_id) VALUES ($1, NOW(), $2)', [sid, other.rows[0].id]);
    assert.strictEqual((await addEx(sid, ID('h1'), 'Squat')).status, 404);
  });
});
