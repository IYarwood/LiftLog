// Integration tests for PATCH /api/exercises/:name against the REAL test database.
// The exercise library is shared, so every row this file creates is prefixed
// "zzex_" (exercises, user, session) and removed afterwards.
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
// Starts with a capital so Title Casing (validation/exerciseName.js) leaves it as typed.
const N = (s) => `Zzex_${tag}_${s}`;
let token, userId;
const sessId = `zzex_${tag}_sess`;

const rename = (from, to) => request(app)
  .patch('/api/exercises/' + encodeURIComponent(from))
  .set('Authorization', `Bearer ${token}`)
  .send({ name: to });
const libNames = async () =>
  (await pool.query("SELECT name FROM exercises WHERE name ILIKE 'zzex\\_%' ORDER BY name")).rows.map(r => r.name);

async function cleanup() {
  await pool.query("DELETE FROM exercises WHERE name ILIKE 'zzex\\_%'");
  await pool.query("DELETE FROM users WHERE username LIKE 'zzex\\_%'");   // cascades sessions → exercises → sets
}

describe('exercise rename (integration, real test DB)', { skip }, () => {
  before(async () => {
    await cleanup();   // leftovers from a crashed run
    const u = await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id", [`zzex_user_${tag}`]
    );
    userId = u.rows[0].id;
    token = signToken({ userId, username: `zzex_user_${tag}` });
    for (const n of ['alpha', 'beta', 'gamma']) {
      await pool.query('INSERT INTO exercises (name) VALUES ($1)', [N(n)]);
    }
    // A finished workout that logged "alpha" — its name must survive renames.
    await pool.query(
      "INSERT INTO sessions (id, started_at, finished_at, user_id) VALUES ($1, '2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z', $2)",
      [sessId, userId]
    );
    await pool.query(
      'INSERT INTO session_exercises (id, session_id, name, position) VALUES ($1, $2, $3, 0)',
      [`${sessId}_ex`, sessId, N('alpha')]
    );
  });

  after(async () => {
    await cleanup();
    await pool.end();
  });

  test('401 without a token', async () => {
    const res = await request(app).patch('/api/exercises/' + encodeURIComponent(N('alpha'))).send({ name: N('x') });
    assert.strictEqual(res.status, 401);
    assert.ok((await libNames()).includes(N('alpha')));
  });

  test('400 on a 61-char name, library unchanged', async () => {
    const res = await rename(N('alpha'), 'z'.repeat(61));
    assert.strictEqual(res.status, 400);
    assert.ok((await libNames()).includes(N('alpha')));
  });

  test('404 when the old name does not exist', async () => {
    const res = await rename(N('nope'), N('whatever'));
    assert.strictEqual(res.status, 404);
  });

  test('409 when the new name exists (exact)', async () => {
    const res = await rename(N('alpha'), N('beta'));
    assert.strictEqual(res.status, 409);
    assert.deepStrictEqual(await libNames(), [N('alpha'), N('beta'), N('gamma')]);
  });

  test('409 when the new name exists in a different case', async () => {
    const res = await rename(N('alpha'), N('BETA'));
    assert.strictEqual(res.status, 409);
    assert.deepStrictEqual(await libNames(), [N('alpha'), N('beta'), N('gamma')]);
  });

  test('rename to the same exact name is a 200 no-op', async () => {
    const res = await rename(N('gamma'), N('gamma'));
    assert.strictEqual(res.status, 200);
    assert.ok((await libNames()).includes(N('gamma')));
  });

  test('case-only rename of the same exercise is allowed', async () => {
    const res = await rename(N('gamma'), N('Gamma'));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.name, N('Gamma'));
    const names = await libNames();
    assert.ok(names.includes(N('Gamma')));
    assert.ok(!names.includes(N('gamma')));
  });

  test('rename trims, updates the library, and leaves logged history untouched', async () => {
    const res = await rename(N('alpha'), `   ${N('delta')}  `);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.name, N('delta'));
    const names = await libNames();
    assert.ok(names.includes(N('delta')));
    assert.ok(!names.includes(N('alpha')));

    const hist = await pool.query('SELECT name FROM session_exercises WHERE id = $1', [`${sessId}_ex`]);
    assert.strictEqual(hist.rows[0].name, N('alpha'));

    // and the owner's history API still reports the original name
    const api = await request(app).get('/api/sessions').set('Authorization', `Bearer ${token}`);
    assert.strictEqual(api.status, 200);
    const s = api.body.find(x => x.id === sessId);
    assert.ok(s, 'session should be listed');
    assert.deepStrictEqual(s.exercises.map(e => e.name), [N('alpha')]);
  });

  test('the old name is now free: renaming it again is a 404', async () => {
    const res = await rename(N('alpha'), N('epsilon'));
    assert.strictEqual(res.status, 404);
  });
});
