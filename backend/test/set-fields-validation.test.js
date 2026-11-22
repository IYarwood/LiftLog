const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = 'test-secret';
const request = require('supertest');
const pool = require('../src/db/pool');
const app = require('../src/app');
const { signToken } = require('../src/auth/tokens');
const { parseSetFields } = require('../src/validation/setFields');

const token = signToken({ userId: 7, username: 'ian' });
afterEach(() => mock.restoreAll());

test('parseSetFields accepts valid values, numbers or numeric strings', () => {
  assert.deepStrictEqual(parseSetFields({ reps: 5, weight: 225.5 }), { reps: 5, weight: 225.5, savedAt: null });
  assert.deepStrictEqual(parseSetFields({ reps: '8', weight: '102.25' }), { reps: 8, weight: 102.25, savedAt: null });
  assert.deepStrictEqual(parseSetFields({ reps: 0, weight: 0 }), { reps: 0, weight: 0, savedAt: null });
  assert.deepStrictEqual(parseSetFields({ reps: 9999, weight: 9999.99 }), { reps: 9999, weight: 9999.99, savedAt: null });
  assert.deepStrictEqual(parseSetFields({ savedAt: '2026-11-22T01:00:00.000Z' }),
    { reps: null, weight: null, savedAt: '2026-11-22T01:00:00.000Z' });
});

test('parseSetFields treats absent / null / blank as "unchanged"', () => {
  assert.deepStrictEqual(parseSetFields({}), { reps: null, weight: null, savedAt: null });
  assert.deepStrictEqual(parseSetFields({ reps: null, weight: '  ' }), { reps: null, weight: null, savedAt: null });
  assert.deepStrictEqual(parseSetFields(undefined), { reps: null, weight: null, savedAt: null });
});

test('parseSetFields rounds weight to cents like Postgres does', () => {
  assert.strictEqual(parseSetFields({ weight: '100.004' }).weight, 100);
  assert.ok(parseSetFields({ weight: 9999.995 }).error);   // would round to 10000.00
});

for (const [label, body] of [
  ['fractional reps', { reps: 1.5 }],
  ['fractional reps string', { reps: '1.5' }],
  ['negative reps', { reps: -1 }],
  ['huge reps', { reps: 10000 }],
  ['reps not a number', { reps: 'abc' }],
  ['reps boolean', { reps: true }],
  ['reps array', { reps: [5] }],
  ['weight overflowing NUMERIC(6,2)', { weight: 12345 }],
  ['weight 10000', { weight: '10000' }],
  ['negative weight', { weight: -5 }],
  ['weight not a number', { weight: '12kg' }],
  ['weight Infinity string', { weight: 'Infinity' }],
  ['weight object', { weight: { v: 1 } }],
  ['bad savedAt', { savedAt: 'yesterday-ish' }],
  ['savedAt number', { savedAt: 123 }],
]) {
  test(`PATCH set rejects ${label} with 400 and no DB access`, async () => {
    const q = mock.method(pool, 'query', async () => ({ rows: [{}], rowCount: 1 }));
    const res = await request(app)
      .patch('/api/sessions/s1/exercises/e1/sets/x1')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error);
    assert.strictEqual(q.mock.callCount(), 0);
  });
}

test('PATCH set passes parsed numbers to the UPDATE', async () => {
  const calls = [];
  mock.method(pool, 'query', async (sql, params) => { calls.push({ sql, params }); return { rows: [{}], rowCount: 1 }; });
  const res = await request(app)
    .patch('/api/sessions/s1/exercises/e1/sets/x1')
    .set('Authorization', `Bearer ${token}`)
    .send({ reps: '5', weight: '225.50' });
  assert.strictEqual(res.status, 200);
  const upd = calls.find(c => /UPDATE sets/.test(c.sql));
  assert.deepStrictEqual(upd.params, [5, 225.5, null, 'x1', 'e1']);
});
