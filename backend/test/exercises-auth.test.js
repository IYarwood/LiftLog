const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = 'test-secret';
const request = require('supertest');
const pool = require('../src/db/pool');
const app = require('../src/app');
const { signToken } = require('../src/auth/tokens');

const token = signToken({ userId: 7, username: 'ian' });
const auth = (r) => r.set('Authorization', `Bearer ${token}`);
afterEach(() => mock.restoreAll());

// ─── Auth: every method must 401 without a valid token, and never hit the DB ──
for (const [method, path] of [
  ['get', '/api/exercises'],
  ['post', '/api/exercises'],
  ['delete', '/api/exercises/Squat'],
]) {
  test(`${method.toUpperCase()} ${path} without a token is 401`, async () => {
    const q = mock.method(pool, 'query', async () => ({ rows: [] }));
    const req = request(app)[method](path);
    const res = method === 'post' ? await req.send({ name: 'x' }) : await req;
    assert.strictEqual(res.status, 401);
    assert.strictEqual(q.mock.callCount(), 0);
  });

  test(`${method.toUpperCase()} ${path} with an invalid token is 401`, async () => {
    const q = mock.method(pool, 'query', async () => ({ rows: [] }));
    const req = request(app)[method](path).set('Authorization', 'Bearer not-a-jwt');
    const res = method === 'post' ? await req.send({ name: 'x' }) : await req;
    assert.strictEqual(res.status, 401);
    assert.strictEqual(q.mock.callCount(), 0);
  });
}

test('GET /api/exercises with a token returns the names', async () => {
  mock.method(pool, 'query', async () => ({ rows: [{ name: 'Bench' }, { name: 'Squat' }] }));
  const res = await auth(request(app).get('/api/exercises'));
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, ['Bench', 'Squat']);
});

test('DELETE /api/exercises/:name with a token deletes by name', async () => {
  let captured;
  mock.method(pool, 'query', async (sql, params) => { captured = { sql, params }; return { rows: [] }; });
  const res = await auth(request(app).delete('/api/exercises/Leg%20Press'));
  assert.strictEqual(res.status, 200);
  assert.match(captured.sql, /DELETE FROM exercises/);
  assert.deepStrictEqual(captured.params, ['Leg Press']);
});

// ─── Validation on create ─────────────────────────────────────────────────────
test('POST /api/exercises trims the name before inserting', async () => {
  let captured;
  mock.method(pool, 'query', async (sql, params) => { captured = { sql, params }; return { rows: [] }; });
  const res = await auth(request(app).post('/api/exercises')).send({ name: '  Front Squat \n' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(captured.params, ['Front Squat']);
});

for (const [label, body] of [
  ['missing name', {}],
  ['empty name', { name: '' }],
  ['whitespace-only name', { name: '   \t ' }],
  ['non-string name', { name: 123 }],
  ['array name', { name: ['Squat'] }],
  ['61-char name', { name: 'a'.repeat(61) }],
  ['61 chars after trim', { name: '  ' + 'a'.repeat(61) + '  ' }],
]) {
  test(`POST /api/exercises rejects ${label} with 400 and no insert`, async () => {
    const q = mock.method(pool, 'query', async () => ({ rows: [] }));
    const res = await auth(request(app).post('/api/exercises')).send(body);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(q.mock.callCount(), 0);
  });
}

test('POST /api/exercises accepts exactly 60 chars (padding trimmed first)', async () => {
  let captured;
  mock.method(pool, 'query', async (sql, params) => { captured = params; return { rows: [] }; });
  const name = 'b'.repeat(60);
  const res = await auth(request(app).post('/api/exercises')).send({ name: `   ${name}   ` });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(captured, [name]);
});

test('POST /api/exercises stores HTML-ish names verbatim (escaping is the renderer\'s job)', async () => {
  let captured;
  mock.method(pool, 'query', async (sql, params) => { captured = params; return { rows: [] }; });
  const name = `<img src=x onerror=alert(1)>`;
  const res = await auth(request(app).post('/api/exercises')).send({ name });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(captured, [name]);
});
