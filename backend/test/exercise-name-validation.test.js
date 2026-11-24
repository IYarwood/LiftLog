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
  assert.deepStrictEqual(parseExerciseName('X'.repeat(60)), { name: 'X'.repeat(60) });
  assert.ok(parseExerciseName('x'.repeat(61)).error);
  assert.ok(parseExerciseName('   ').error);
  assert.ok(parseExerciseName(undefined).error);
  assert.ok(parseExerciseName(42).error);
  assert.ok(parseExerciseName(['Squat']).error);
});

test('parseExerciseName Title Cases names without lowercasing typed capitals', () => {
  for (const [input, want] of [
    ['leg curl', 'Leg Curl'],
    ['lying leg curl', 'Lying Leg Curl'],
    ['push-ups', 'Push-Ups'],
    ['single-leg RDL', 'Single-Leg RDL'],
    ['RDL', 'RDL'],
    ['EZ bar curl', 'EZ Bar Curl'],
    ['McGill big 3', 'McGill Big 3'],
    ['straight arm pulldown', 'Straight Arm Pulldown'],
    ['Straight Arm Pulldown', 'Straight Arm Pulldown'],
    ["farmer's walk", "Farmer's Walk"],
    ['curl (cable)', 'Curl (Cable)'],
    ['3x5 squat', '3x5 Squat'],
    ['éclair press', 'Éclair Press'],
  ]) {
    assert.deepStrictEqual(parseExerciseName(input), { name: want }, input);
  }
});

test('parseExerciseName collapses repeated internal whitespace', () => {
  assert.deepStrictEqual(parseExerciseName('  leg    curl  '), { name: 'Leg Curl' });
  assert.deepStrictEqual(parseExerciseName('leg \t curl'), { name: 'Leg Curl' });
  assert.deepStrictEqual(parseExerciseName('push -  ups'), { name: 'Push - Ups' });
});

test('POST /api/sessions/:id/exercises stores and returns the Title Cased name', async () => {
  const { insert } = mockOwnedSession();
  const res = await auth(request(app).post('/api/sessions/s1/exercises'))
    .send({ id: 'ex1', name: ' leg  curl ', position: 0 });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { ok: true, id: 'ex1', name: 'Leg Curl' });
  assert.strictEqual(insert().params[2], 'Leg Curl');
});

test('parseExerciseName rejects names made only of dots', () => {
  for (const n of ['.', '..', '...', '  ..  ', '.'.repeat(60)]) {
    assert.deepStrictEqual(parseExerciseName(n), { error: 'name cannot be only dots' }, JSON.stringify(n));
  }
  // dots alongside other characters are fine
  assert.deepStrictEqual(parseExerciseName('..Squat'), { name: '..Squat' });
  assert.deepStrictEqual(parseExerciseName('A.B.'), { name: 'A.B.' });
  assert.deepStrictEqual(parseExerciseName('. .'), { name: '. .' });
});

for (const [method, url] of [
  ['post', '/api/exercises'],
  ['patch', '/api/exercises/Squat'],
  ['post', '/api/sessions/s1/exercises'],
]) {
  test(`${method.toUpperCase()} ${url} rejects a dots-only name with 400 and no DB access`, async () => {
    const q = mock.method(pool, 'query', async () => ({ rows: [] }));
    const c = mock.method(pool, 'connect', async () => { throw new Error('should not connect'); });
    const res = await auth(request(app)[method](url)).send({ id: 'ex1', name: '..' });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'name cannot be only dots');
    assert.strictEqual(q.mock.callCount() + c.mock.callCount(), 0);
  });
}

// ─── POST /api/sessions/:id/exercises ─────────────────────────────────────────
// Owned session: the route runs in a transaction on a pooled client. The
// ownership SELECT returns a row, the duplicate check returns none; capture the
// INSERT. `q` counts DB access (connect or query).
function mockOwnedSession() {
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM sessions/.test(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const q = mock.method(pool, 'connect', async () => client);
  mock.method(pool, 'query', async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; });
  return { q, insert: () => calls.find(c => /INSERT INTO session_exercises/.test(c.sql)) };
}

test('POST /api/sessions/:id/exercises adds a library exercise unchanged', async () => {
  const { insert } = mockOwnedSession();
  const res = await auth(request(app).post('/api/sessions/s1/exercises'))
    .send({ id: 'ex1', name: 'Bench Press', position: 2 });
  assert.strictEqual(res.status, 200);
  // position is assigned server-side (MAX + 1), the client's value is ignored
  assert.deepStrictEqual(insert().params, ['ex1', 's1', 'Bench Press']);
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
  const name = 'B'.repeat(60);
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

// ─── Transaction cleanup in POST /api/sessions/:id/exercises ──────────────────
// A client whose queries fail as configured; records what release() got.
function mockFailingClient({ failOn, rollbackFails }) {
  const released = [];
  const client = {
    query: async (sql) => {
      if (sql === 'ROLLBACK' && rollbackFails) throw new Error('connection lost');
      if (failOn.test(sql)) throw new Error('boom');
      if (/FROM sessions/.test(sql)) return { rows: [{ '?column?': 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: (err) => released.push(err),
  };
  mock.method(pool, 'connect', async () => client);
  mock.method(console, 'error', () => {});
  return released;
}

test('POST session exercise: failed insert rolls back and returns the client to the pool', async () => {
  const released = mockFailingClient({ failOn: /INSERT/, rollbackFails: false });
  const res = await auth(request(app).post('/api/sessions/s1/exercises')).send({ id: 'ex1', name: 'Squat' });
  assert.strictEqual(res.status, 500);
  assert.deepStrictEqual(released, [undefined]);
});

test('POST session exercise: if ROLLBACK also fails, the client is released with the error (destroyed)', async () => {
  const released = mockFailingClient({ failOn: /INSERT/, rollbackFails: true });
  const res = await auth(request(app).post('/api/sessions/s1/exercises')).send({ id: 'ex1', name: 'Squat' });
  assert.strictEqual(res.status, 500);
  assert.strictEqual(released.length, 1);
  assert.ok(released[0] instanceof Error);
});

test('POST session exercise: a failing ROLLBACK on the 404 path is a 500 and destroys the client', async () => {
  const released = [];
  const client = {
    query: async (sql) => {
      if (sql === 'ROLLBACK') throw new Error('connection lost');
      return { rows: [], rowCount: 0 };   // ownership check finds nothing → 404 path
    },
    release: (err) => released.push(err),
  };
  mock.method(pool, 'connect', async () => client);
  mock.method(console, 'error', () => {});
  const res = await auth(request(app).post('/api/sessions/s1/exercises')).send({ id: 'ex1', name: 'Squat' });
  assert.strictEqual(res.status, 500);
  assert.ok(released[0] instanceof Error);
});
