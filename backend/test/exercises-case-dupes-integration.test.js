// Integration tests for case-insensitive exercise-name uniqueness against the
// REAL test database: POST /api/exercises, PATCH /api/exercises/:name, the
// idx_exercises_name_lower unique index, and its migration.
// Every row this file creates is prefixed "zzdup_" and removed afterwards
// (a different prefix from exercises-rename-integration, which runs in parallel).
// Safety: only runs when DATABASE_URL points at a database whose name ends in
// "_test" (e.g. liftlog_test) and is skipped otherwise — never against prod.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
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

const MIGRATION = fs.readFileSync(
  path.resolve(__dirname, '../migrations/2026-11-22-exercise-name-ci-unique.sql'), 'utf8'
);

const tag = Math.random().toString(36).slice(2, 8);
const N = (s) => `zzdup_${tag}_${s}`;
let token;

const add = (name) => request(app)
  .post('/api/exercises')
  .set('Authorization', `Bearer ${token}`)
  .send({ name });
const rename = (from, to) => request(app)
  .patch('/api/exercises/' + encodeURIComponent(from))
  .set('Authorization', `Bearer ${token}`)
  .send({ name: to });
const libNames = async () =>
  (await pool.query("SELECT name FROM exercises WHERE name ILIKE 'zzdup\\_%' ORDER BY name")).rows.map(r => r.name);

async function cleanup() {
  await pool.query("DELETE FROM exercises WHERE name ILIKE 'zzdup\\_%'");
  await pool.query("DELETE FROM users WHERE username LIKE 'zzdup\\_%'");
}

describe('case-insensitive exercise names (integration, real test DB)', { skip }, () => {
  before(async () => {
    await cleanup();
    const u = await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id", [`zzdup_user_${tag}`]
    );
    token = signToken({ userId: u.rows[0].id, username: `zzdup_user_${tag}` });
  });

  after(async () => {
    await cleanup();
    await pool.end();
  });

  test('the case-insensitive unique index exists', async () => {
    const r = await pool.query(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'exercises' AND indexname = 'idx_exercises_name_lower'"
    );
    assert.strictEqual(r.rows.length, 1, 'run migrations/2026-11-22-exercise-name-ci-unique.sql on the test DB');
    assert.match(r.rows[0].indexdef, /UNIQUE INDEX .* \(lower\(name\)\)/);
  });

  test('POST a new name → 200 with the stored (trimmed) name', async () => {
    const res = await add(`  ${N('Squat')} `);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { ok: true, name: N('Squat') });
    assert.deepStrictEqual(await libNames(), [N('Squat')]);
  });

  test('POST an exact duplicate → 409 with the library name, no new row', async () => {
    const res = await add(N('Squat'));
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.name, N('Squat'));
    assert.match(res.body.error, /already exists/);
    assert.deepStrictEqual(await libNames(), [N('Squat')]);
  });

  test('POST a case variant → 409, same body shape as exact, library casing returned', async () => {
    for (const variant of [N('squat'), N('SQUAT'), `  ${N('sQuAt')}  `]) {
      const res = await add(variant);
      assert.strictEqual(res.status, 409, variant);
      assert.strictEqual(res.body.name, N('Squat'));
      assert.match(res.body.error, /already exists/);
    }
    assert.deepStrictEqual(await libNames(), [N('Squat')]);
  });

  test('racing case-variant creates → exactly one row, one 200, rest 409', async () => {
    const variants = ['race', 'Race', 'RACE', 'rAce', 'raCe', 'racE', 'RAce', 'rACE'].map(N);
    const results = await Promise.all(variants.map(v => add(v)));
    const ok = results.filter(r => r.status === 200);
    const conflict = results.filter(r => r.status === 409);
    assert.strictEqual(ok.length, 1, `statuses: ${results.map(r => r.status)}`);
    assert.strictEqual(conflict.length, variants.length - 1);
    const rows = (await libNames()).filter(n => n.toLowerCase() === N('race').toLowerCase());
    assert.deepStrictEqual(rows, [ok[0].body.name]);
    for (const r of conflict) {
      // null only if the row vanished between insert and lookup, which can't happen here
      assert.strictEqual(r.body.name, ok[0].body.name);
    }
  });

  test('the database itself rejects a case variant (23505), bypassing the API', async () => {
    await assert.rejects(
      pool.query('INSERT INTO exercises (name) VALUES ($1)', [N('SQUAT')]),
      (err) => err.code === '23505' && /idx_exercises_name_lower/.test(err.constraint || err.message)
    );
    await assert.rejects(
      pool.query("UPDATE exercises SET name = $1 WHERE name = $2", [N('RACE'), N('Squat')]),
      (err) => err.code === '23505'
    );
  });

  test('PATCH rename into a case variant of another exercise → 409', async () => {
    await add(N('Bench'));
    const res = await rename(N('Bench'), N('sQUAT'));
    assert.strictEqual(res.status, 409);
    const names = await libNames();
    assert.ok(names.includes(N('Bench')) && names.includes(N('Squat')));
  });

  test('racing renames into case variants of one new name → exactly one wins', async () => {
    await add(N('one'));
    await add(N('two'));
    const results = await Promise.all([rename(N('one'), N('target')), rename(N('two'), N('TARGET'))]);
    const statuses = results.map(r => r.status).sort();
    assert.deepStrictEqual(statuses, [200, 409]);
    const rows = (await libNames()).filter(n => n.toLowerCase() === N('target').toLowerCase());
    assert.strictEqual(rows.length, 1);
  });

  test('case-only rename of the same exercise is still allowed', async () => {
    const res = await rename(N('Bench'), N('BENCH'));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.name, N('BENCH'));
    const names = await libNames();
    assert.ok(names.includes(N('BENCH')) && !names.includes(N('Bench')));
  });

  test('the migration is idempotent (re-running it is a no-op)', async () => {
    await pool.query(MIGRATION);
    await pool.query(MIGRATION);
    const r = await pool.query(
      "SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = 'exercises' AND indexname = 'idx_exercises_name_lower'"
    );
    assert.strictEqual(r.rows[0].n, 1);
  });

  test('the migration refuses to run while case-variant duplicates exist', async () => {
    // Simulate a pre-migration DB inside a transaction that is always rolled back.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP INDEX idx_exercises_name_lower');
      await client.query('INSERT INTO exercises (name) VALUES ($1), ($2)', [N('dupe'), N('DUPE')]);
      await assert.rejects(client.query(MIGRATION), (err) => {
        assert.match(err.message, /differ only by case/);
        assert.ok(err.message.includes(N('DUPE')) && err.message.includes(N('dupe')), err.message);
        return true;
      });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    const r = await pool.query(
      "SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'idx_exercises_name_lower'"
    );
    assert.strictEqual(r.rows[0].n, 1, 'index must survive the rolled-back simulation');
  });
});
