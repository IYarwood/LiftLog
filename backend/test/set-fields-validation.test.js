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

const fieldsOf = (body) => parseSetFields(body).fields;

test('parseSetFields accepts valid values, numbers or numeric strings', () => {
  assert.deepStrictEqual(fieldsOf({ reps: 5, weight: 225.5 }), { reps: 5, weight: 225.5 });
  assert.deepStrictEqual(fieldsOf({ reps: '8', weight: '102.25' }), { reps: 8, weight: 102.25 });
  assert.deepStrictEqual(fieldsOf({ reps: 0, weight: 0 }), { reps: 0, weight: 0 });
  assert.deepStrictEqual(fieldsOf({ reps: 9999, weight: 9999.99 }), { reps: 9999, weight: 9999.99 });
  assert.deepStrictEqual(fieldsOf({ savedAt: '2026-11-22T01:00:00.000Z' }), { savedAt: '2026-11-22T01:00:00.000Z' });
});

test('parseSetFields: an omitted field is left out (keep), null or blank is null (clear)', () => {
  assert.deepStrictEqual(fieldsOf({}), {});
  assert.deepStrictEqual(fieldsOf(undefined), {});
  assert.deepStrictEqual(fieldsOf({ reps: undefined }), {});
  assert.deepStrictEqual(fieldsOf({ reps: null }), { reps: null });
  assert.deepStrictEqual(fieldsOf({ weight: '  ' }), { weight: null });
  assert.deepStrictEqual(fieldsOf({ reps: 5 }), { reps: 5 });          // weight untouched
  assert.deepStrictEqual(fieldsOf({ savedAt: null }), {});              // can't un-save
});

test('parseSetFields rounds weight to cents like Postgres does', () => {
  assert.strictEqual(fieldsOf({ weight: '100.004' }).weight, 100);
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
  // [reps sent?, reps, weight sent?, weight, savedAt, setId, exId]
  assert.deepStrictEqual(upd.params, [true, 5, true, 225.5, null, 'x1', 'e1']);
});

test('PATCH set: an omitted field is marked "not sent", an explicit null is sent as a clear', async () => {
  const calls = [];
  mock.method(pool, 'query', async (sql, params) => { calls.push({ sql, params }); return { rows: [{}], rowCount: 1 }; });
  const res = await request(app)
    .patch('/api/sessions/s1/exercises/e1/sets/x1')
    .set('Authorization', `Bearer ${token}`)
    .send({ weight: null });
  assert.strictEqual(res.status, 200);
  const upd = calls.find(c => /UPDATE sets/.test(c.sql));
  assert.deepStrictEqual(upd.params, [false, null, true, null, null, 'x1', 'e1']);
});

// ─── savedAt: strict ISO-8601 (review round 4) ────────────────────────────────
const { isIsoDateTime } = require('../src/validation/setFields');
const GOOD_DATES = [
  '2026-11-22T01:00:00.000Z',   // what the browser sends (toISOString)
  '2026-11-22T01:00:00Z',
  '2026-11-22T01:00Z',
  '2026-11-22T01:00:00.123456Z',
  '2026-11-22T01:00:00+02:00',
  '2024-02-29T00:00:00Z',       // leap day
];
const BAD_DATES = [
  '2020', '2026-11-22', '2026-11-22 01:00:00Z', '2026-11-22T01:00:00',   // no zone
  '2026-02-31T00:00:00Z', '2025-02-29T00:00:00Z', '2026-13-01T00:00:00Z',
  '2026-11-22T24:00:00Z', '2026-11-22T01:60:00Z', '2026-11-22T01:00:60Z',
  '0000-01-01T00:00:00Z', '2026-11-22T01:00:00+15:00', 'yesterday', '',
  '2026-11-22T01:00:00.1234567Z',
];

test('isIsoDateTime accepts full ISO date-times with a zone', () => {
  for (const s of GOOD_DATES) assert.ok(isIsoDateTime(s), s);
});

test('isIsoDateTime rejects partial, zoneless and impossible dates', () => {
  for (const s of BAD_DATES) assert.ok(!isIsoDateTime(s), s);
  for (const v of [null, undefined, 123, {}]) assert.ok(!isIsoDateTime(v));
});

for (const s of ['2020', '2026-02-31T00:00:00Z', '2026-11-22']) {
  test(`PATCH set rejects savedAt ${JSON.stringify(s)} with 400 and no DB access`, async () => {
    const q = mock.method(pool, 'query', async () => ({ rows: [{}], rowCount: 1 }));
    const res = await request(app)
      .patch('/api/sessions/s1/exercises/e1/sets/x1')
      .set('Authorization', `Bearer ${token}`)
      .send({ savedAt: s });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /ISO-8601/);
    assert.strictEqual(q.mock.callCount(), 0);
  });
}
