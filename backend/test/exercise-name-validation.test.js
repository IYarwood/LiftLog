const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = 'test-secret';
const request = require('supertest');
const pool = require('../src/db/pool');
const app = require('../src/app');
const { signToken } = require('../src/auth/tokens');
const { MAX_EXERCISE_NAME_LENGTH, parseExerciseName } = require('../src/validation/exerciseName');

const token = signToken({ userId: 7, username: 'ian' });
const auth = (r) => r.set('Authorization', `Bearer ${token}`);
afterEach(() => mock.restoreAll());

// ─── Shared helper ────────────────────────────────────────────────────────────
test('exercise name cap is 60', () => {
  assert.strictEqual(MAX_EXERCISE_NAME_LENGTH, 60);
});

test('parseExerciseName trims and enforces 1–60 chars', () => {
  assert.deepStrictEqual(parseExerciseName('  Squat  '), { name: 'Squat' });
  assert.deepStrictEqual(parseExerciseName('x'.repeat(60)), { name: 'x'.repeat(60) });
  assert.ok(parseExerciseName('x'.repeat(61)).error);
  assert.ok(parseExerciseName('   ').error);
  assert.ok(parseExerciseName(undefined).error);
  assert.ok(parseExerciseName(42).error);
  assert.ok(parseExerciseName(['Squat']).error);
});

// ─── POST /api/sessions/:id/exercises ─────────────────────────────────────────
// Owned session: the ownership SELECT returns a row; capture the INSERT.
function mockOwnedSession() {
  const calls = [];
  const q = mock.method(pool, 'query', async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [{ '?column?': 1 }], rowCount: 1 };
  });
  return { q, insert: () => calls.find(c => /INSERT INTO session_exercises/.test(c.sql)) };
}

test('POST /api/sessions/:id/exercises adds a library exercise unchanged', async () => {
  const { insert } = mockOwnedSession();
  const res = await auth(request(app).post('/api/sessions/s1/exercises'))
    .send({ id: 'ex1', name: 'Bench Press', position: 2 });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(insert().params, ['ex1', 's1', 'Bench Press', 2]);
});

test('POST /api/sessions/:id/exercises trims the name before inserting', async () => {
  const { insert } = mockOwnedSession();
  const res = await auth(request(app).post('/api/sessions/s1/exercises'))
    .send({ id: 'ex1', name: '  Front Squat \n', position: 0 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(insert().params[2], 'Front Squat');
});

test('POST /api/sessions/:id/exercises accepts exactly 60 chars (padding trimmed first)', async () => {
  const { insert } = mockOwnedSession();
  const name = 'b'.repeat(60);
  const res = await auth(request(app).post('/api/sessions/s1/exercises'))
    .send({ id: 'ex1', name: `  ${name}  `, position: 0 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(insert().params[2], name);
});

for (const [label, body] of [
  ['missing id', { name: 'Squat' }],
  ['missing name', { id: 'ex1' }],
  ['empty name', { id: 'ex1', name: '' }],
  ['whitespace-only name', { id: 'ex1', name: '  \t ' }],
  ['non-string name', { id: 'ex1', name: 123 }],
  ['array name', { id: 'ex1', name: ['Squat'] }],
  ['object name', { id: 'ex1', name: { a: 1 } }],
  ['61-char name', { id: 'ex1', name: 'a'.repeat(61) }],
  ['61 chars after trim', { id: 'ex1', name: '  ' + 'a'.repeat(61) + '  ' }],
]) {
  test(`POST /api/sessions/:id/exercises rejects ${label} with 400 and no DB access`, async () => {
    const { q } = mockOwnedSession();
    const res = await auth(request(app).post('/api/sessions/s1/exercises')).send(body);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(q.mock.callCount(), 0);
  });
}

test('POST /api/sessions/:id/exercises without a token is 401', async () => {
  const q = mock.method(pool, 'query', async () => ({ rows: [] }));
  const res = await request(app).post('/api/sessions/s1/exercises').send({ id: 'ex1', name: 'Squat' });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(q.mock.callCount(), 0);
});
