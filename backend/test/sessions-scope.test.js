const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = 'test-secret';
const request = require('supertest');
const pool = require('../src/db/pool');
const app = require('../src/app');
const { signToken } = require('../src/auth/tokens');

const token = signToken({ userId: 7, username: 'ian' });
afterEach(() => mock.restoreAll());

test('GET /api/sessions without a token is 401', async () => {
  const res = await request(app).get('/api/sessions');
  assert.strictEqual(res.status, 401);
});

test('GET /api/sessions scopes the list query to the user', async () => {
  let captured;
  mock.method(pool, 'query', async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  });
  const res = await request(app).get('/api/sessions').set('Authorization', `Bearer ${token}`);
  assert.strictEqual(res.status, 200);
  assert.match(captured.sql, /user_id = \$1/);
  assert.deepStrictEqual(captured.params, [7]);
});

test('GET /api/sessions/active scopes the query to the user', async () => {
  let captured;
  mock.method(pool, 'query', async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };   // no active session
  });
  const res = await request(app).get('/api/sessions/active').set('Authorization', `Bearer ${token}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body, null);
  assert.match(captured.sql, /finished_at IS NULL/);
  assert.match(captured.sql, /user_id = \$1/);
  assert.deepStrictEqual(captured.params, [7]);
});

test('GET /api/sessions/active without a token is 401', async () => {
  const res = await request(app).get('/api/sessions/active');
  assert.strictEqual(res.status, 401);
});

test('GET /api/sessions/:id returns 404 when the session is not owned', async () => {
  mock.method(pool, 'query', async () => ({ rows: [] }));
  const res = await request(app).get('/api/sessions/abc').set('Authorization', `Bearer ${token}`);
  assert.strictEqual(res.status, 404);
});

test('POST /api/sessions inserts with the user_id', async () => {
  let captured;
  mock.method(pool, 'query', async (sql, params) => {
    captured = { sql, params };
    return { rows: [], rowCount: 1 };
  });
  const res = await request(app)
    .post('/api/sessions')
    .set('Authorization', `Bearer ${token}`)
    .send({ id: 'x', startedAt: '2026-01-01T00:00:00.000Z' });
  assert.strictEqual(res.status, 200);
  assert.match(captured.sql, /user_id/);
  assert.deepStrictEqual(captured.params, ['x', '2026-01-01T00:00:00.000Z', 7]);
});

test('POST nested set returns 404 when the exercise is not in the owned session', async () => {
  // ownsSessionExercise returns no rows → exercise is not in the owned session
  mock.method(pool, 'query', async () => ({ rows: [] }));
  const res = await request(app)
    .post('/api/sessions/abc/exercises/ex1/sets')
    .set('Authorization', `Bearer ${token}`)
    .send({ id: 's1', position: 0 });
  assert.strictEqual(res.status, 404);
});

test('DELETE exercise returns 404 when exId is not in the owned session', async () => {
  // ownsSessionExercise check returns no rows → foreign child
  mock.method(pool, 'query', async () => ({ rows: [] }));
  const res = await request(app)
    .delete('/api/sessions/abc/exercises/ex1')
    .set('Authorization', `Bearer ${token}`);
  assert.strictEqual(res.status, 404);
});

test('PATCH set returns 404 when exId is not in the owned session', async () => {
  // ownsSessionExercise check returns no rows → foreign child
  mock.method(pool, 'query', async () => ({ rows: [] }));
  const res = await request(app)
    .patch('/api/sessions/abc/exercises/ex1/sets/s1')
    .set('Authorization', `Bearer ${token}`)
    .send({ reps: 10 });
  assert.strictEqual(res.status, 404);
});

test('DELETE set returns 404 when exId is not in the owned session', async () => {
  // ownsSessionExercise check returns no rows → foreign child
  mock.method(pool, 'query', async () => ({ rows: [] }));
  const res = await request(app)
    .delete('/api/sessions/abc/exercises/ex1/sets/s1')
    .set('Authorization', `Bearer ${token}`);
  assert.strictEqual(res.status, 404);
});

test('DELETE exercise scopes delete to session when exercise is owned', async () => {
  let callCount = 0;
  let capturedMutation;
  mock.method(pool, 'query', async (sql, params) => {
    callCount++;
    if (callCount === 1) {
      // ownsSessionExercise returns owned
      return { rows: [{}] };
    }
    capturedMutation = { sql, params };
    return { rows: [], rowCount: 1 };
  });
  const res = await request(app)
    .delete('/api/sessions/abc/exercises/ex1')
    .set('Authorization', `Bearer ${token}`);
  assert.strictEqual(res.status, 200);
  assert.match(capturedMutation.sql, /session_id/);
  assert.ok(capturedMutation.params.includes('abc'));
});

test('PATCH set scopes update to session_exercise when exercise is owned', async () => {
  let callCount = 0;
  let capturedMutation;
  mock.method(pool, 'query', async (sql, params) => {
    callCount++;
    if (callCount === 1) {
      // ownsSessionExercise returns owned
      return { rows: [{}] };
    }
    capturedMutation = { sql, params };
    return { rows: [], rowCount: 1 };
  });
  const res = await request(app)
    .patch('/api/sessions/abc/exercises/ex1/sets/s1')
    .set('Authorization', `Bearer ${token}`)
    .send({ reps: 10 });
  assert.strictEqual(res.status, 200);
  assert.match(capturedMutation.sql, /session_exercise_id/);
  assert.ok(capturedMutation.params.includes('ex1'));
});

test('DELETE set scopes delete to session_exercise when exercise is owned', async () => {
  let callCount = 0;
  let capturedMutation;
  mock.method(pool, 'query', async (sql, params) => {
    callCount++;
    if (callCount === 1) {
      // ownsSessionExercise returns owned
      return { rows: [{}] };
    }
    capturedMutation = { sql, params };
    return { rows: [], rowCount: 1 };
  });
  const res = await request(app)
    .delete('/api/sessions/abc/exercises/ex1/sets/s1')
    .set('Authorization', `Bearer ${token}`);
  assert.strictEqual(res.status, 200);
  assert.match(capturedMutation.sql, /session_exercise_id/);
  assert.ok(capturedMutation.params.includes('ex1'));
});
