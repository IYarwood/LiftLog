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

test('POST nested set returns 404 when the parent session is not owned', async () => {
  // ownsSession check returns no rows → not owned
  mock.method(pool, 'query', async () => ({ rows: [] }));
  const res = await request(app)
    .post('/api/sessions/abc/exercises/ex1/sets')
    .set('Authorization', `Bearer ${token}`)
    .send({ id: 's1', position: 0 });
  assert.strictEqual(res.status, 404);
});
