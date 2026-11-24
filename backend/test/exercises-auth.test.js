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
  ['patch', '/api/exercises/Squat'],
  ['delete', '/api/exercises/Squat'],
]) {
  test(`${method.toUpperCase()} ${path} without a token is 401`, async () => {
    const q = mock.method(pool, 'query', async () => ({ rows: [] }));
    const req = request(app)[method](path);
    const res = (method === 'post' || method === 'patch') ? await req.send({ name: 'x' }) : await req;
    assert.strictEqual(res.status, 401);
    assert.strictEqual(q.mock.callCount(), 0);
  });

  test(`${method.toUpperCase()} ${path} with an invalid token is 401`, async () => {
    const q = mock.method(pool, 'query', async () => ({ rows: [] }));
    const req = request(app)[method](path).set('Authorization', 'Bearer not-a-jwt');
    const res = (method === 'post' || method === 'patch') ? await req.send({ name: 'x' }) : await req;
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
  mock.method(pool, 'query', async (sql, params) => { captured = { sql, params }; return { rows: [{ name: params[0] }] }; });
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
  mock.method(pool, 'query', async (sql, params) => { captured = params; return { rows: [{ name: params[0] }] }; });  // INSERT ... RETURNING name
  const name = 'B'.repeat(60);
  const res = await auth(request(app).post('/api/exercises')).send({ name: `   ${name}   ` });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(captured, [name]);
});

test('POST /api/exercises stores HTML-ish names unescaped (escaping is the renderer\'s job)', async () => {
  let captured;
  mock.method(pool, 'query', async (sql, params) => { captured = params; return { rows: [{ name: params[0] }] }; });  // INSERT ... RETURNING name
  const name = `<img Src=x Onerror=alert(1)>`;   // already Title Cased, so stored as sent
  const res = await auth(request(app).post('/api/exercises')).send({ name });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(captured, [name]);
});

test('POST /api/exercises Title Cases the name and returns the stored spelling', async () => {
  let captured;
  mock.method(pool, 'query', async (sql, params) => { captured = params; return { rows: [{ name: params[0] }] }; });  // INSERT ... RETURNING name
  const res = await auth(request(app).post('/api/exercises')).send({ name: '  single-leg  RDL ' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(captured, ['Single-Leg RDL']);
  assert.deepStrictEqual(res.body, { ok: true, name: 'Single-Leg RDL' });
});

// ─── Validation on rename (same rules as create) ──────────────────────────────
for (const [label, body] of [
  ['missing name', {}],
  ['empty name', { name: '' }],
  ['whitespace-only name', { name: '   ' }],
  ['non-string name', { name: 5 }],
  ['61-char name', { name: 'z'.repeat(61) }],
]) {
  test(`PATCH /api/exercises/:name rejects ${label} with 400 and no DB access`, async () => {
    const q = mock.method(pool, 'query', async () => ({ rows: [] }));
    const res = await auth(request(app).patch('/api/exercises/Squat')).send(body);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(q.mock.callCount(), 0);
  });
}

test('PATCH /api/exercises/:name trims the new name and updates only the library', async () => {
  const calls = [];
  mock.method(pool, 'query', async (sql, params) => {
    calls.push({ sql, params });
    if (/SELECT id FROM exercises/.test(sql)) return { rows: [{ id: 3 }] };
    if (/UPDATE/.test(sql)) return { rows: [], rowCount: 1 };
    return { rows: [] };
  });
  const res = await auth(request(app).patch('/api/exercises/Leg%20Press')).send({ name: '  Hack Squat ' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { ok: true, name: 'Hack Squat' });
  assert.deepStrictEqual(calls[0].params, ['Leg Press']);
  const upd = calls.find(c => /UPDATE/.test(c.sql));
  assert.match(upd.sql, /UPDATE exercises SET name/);
  assert.deepStrictEqual(upd.params, ['Hack Squat', 3]);
  assert.ok(calls.every(c => !/session_exercises/.test(c.sql)), 'must not touch session_exercises');
});

test('PATCH /api/exercises/:name maps a unique violation race to 409', async () => {
  mock.method(pool, 'query', async (sql) => {
    if (/SELECT id FROM exercises/.test(sql)) return { rows: [{ id: 3 }] };
    if (/UPDATE/.test(sql)) { const e = new Error('dup'); e.code = '23505'; throw e; }
    return { rows: [] };
  });
  const res = await auth(request(app).patch('/api/exercises/Squat')).send({ name: 'Bench Press' });
  assert.strictEqual(res.status, 409);
});
