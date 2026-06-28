const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = 'test-secret';
const request = require('supertest');
const pool = require('../src/db/pool');
const app = require('../src/app');
const { signToken } = require('../src/auth/tokens');

afterEach(() => mock.restoreAll());

test('login returns a token and lowercases the username lookup', async () => {
  const hash = await bcrypt.hash('pw', 10);
  let queriedWith;
  mock.method(pool, 'query', async (sql, params) => {
    queriedWith = params;
    return { rows: [{ id: 1, username: 'ian', password_hash: hash }] };
  });
  const res = await request(app).post('/api/auth/login').send({ username: 'Ian', password: 'pw' });
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.token);
  assert.strictEqual(res.body.username, 'ian');
  assert.deepStrictEqual(queriedWith, ['ian']);
});

test('login returns generic 401 for a wrong password', async () => {
  const hash = await bcrypt.hash('right', 10);
  mock.method(pool, 'query', async () => ({ rows: [{ id: 1, username: 'ian', password_hash: hash }] }));
  const res = await request(app).post('/api/auth/login').send({ username: 'ian', password: 'wrong' });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body.error, 'Invalid username or password');
});

test('login returns the same generic 401 for an unknown user', async () => {
  mock.method(pool, 'query', async () => ({ rows: [] }));
  const res = await request(app).post('/api/auth/login').send({ username: 'nobody', password: 'pw' });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.body.error, 'Invalid username or password');
});

test('me returns the username for a valid token', async () => {
  const token = signToken({ userId: 1, username: 'ian' });
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.username, 'ian');
});

test('me returns 401 without a token', async () => {
  const res = await request(app).get('/api/auth/me');
  assert.strictEqual(res.status, 401);
});
