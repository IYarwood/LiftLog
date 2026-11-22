// Integration tests for exercises inside a session, against the REAL test DB:
// one-exercise-per-session (case-insensitive 409) and idempotent re-sends.
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

  test("another user's session → 404", async () => {
    const other = await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id", [`zzsx_other_${tag}`]
    );
    const sid = ID('foreign');
    await pool.query('INSERT INTO sessions (id, started_at, user_id) VALUES ($1, NOW(), $2)', [sid, other.rows[0].id]);
    assert.strictEqual((await addEx(sid, ID('h1'), 'Squat')).status, 404);
  });
});
