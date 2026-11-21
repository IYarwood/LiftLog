// Integration tests for friends authorization against the REAL test database.
// They create throwaway users (prefix "zzfr_") and delete them afterwards.
// Safety: they only run when DATABASE_URL points at a database whose name ends
// in "_test" (e.g. liftlog_test) and are skipped otherwise — never against prod.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');
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

const tag = Math.random().toString(36).slice(2, 8);
const names = { alice: `zzfr_alice_${tag}`, bob: `zzfr_bob_${tag}`, carol: `zzfr_carol_${tag}` };
const U = {};   // name -> { id, username, token }

const auth = (who) => ({ Authorization: `Bearer ${U[who].token}` });
const get = (who, url) => request(app).get(url).set(auth(who));

async function makeUser(key) {
  const r = await pool.query(
    "INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id",
    [names[key]]
  );
  U[key] = { id: r.rows[0].id, username: names[key], token: signToken({ userId: r.rows[0].id, username: names[key] }) };
}

async function makeSession(key, id, { finished, at }) {
  await pool.query(
    'INSERT INTO sessions (id, started_at, finished_at, user_id) VALUES ($1, $2, $3, $4)',
    [id, at, finished ? at : null, U[key].id]
  );
  await pool.query(
    "INSERT INTO session_exercises (id, session_id, name, position) VALUES ($1, $2, 'Squat', 0)",
    [`${id}_ex`, id]
  );
  await pool.query(
    "INSERT INTO sets (id, session_exercise_id, reps, weight, saved_at, position) VALUES ($1, $2, 5, 225, $3, 0)",
    [`${id}_set`, `${id}_ex`, at]
  );
}

describe('friends (integration, real test DB)', { skip }, () => {
  before(async () => {
    await pool.query("DELETE FROM users WHERE username LIKE 'zzfr\\_%'");   // leftovers from a crashed run
    for (const k of Object.keys(names)) await makeUser(k);
    await makeSession('bob', `zzfr_${tag}_b1`, { finished: true, at: '2026-01-01T10:00:00Z' });
    await makeSession('bob', `zzfr_${tag}_b2`, { finished: true, at: '2026-01-02T10:00:00Z' });
    await makeSession('bob', `zzfr_${tag}_b3`, { finished: true, at: '2026-01-03T10:00:00Z' });
    await makeSession('bob', `zzfr_${tag}_bactive`, { finished: false, at: '2026-01-04T10:00:00Z' });
    await makeSession('carol', `zzfr_${tag}_c1`, { finished: true, at: '2026-01-05T10:00:00Z' });
  });

  after(async () => {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [Object.values(U).map(u => u.id)]);
    await pool.end();
  });

  const b1 = () => `zzfr_${tag}_b1`;
  const bActive = () => `zzfr_${tag}_bactive`;

  test('friends endpoints require a token', async () => {
    assert.strictEqual((await request(app).get('/api/friends')).status, 401);
    assert.strictEqual((await request(app).get('/api/feed')).status, 401);
    assert.strictEqual((await request(app).get(`/api/friends/${names.bob}/sessions`)).status, 401);
  });

  test('search: prefix match, excludes self, exposes only username + status', async () => {
    const res = await get('alice', `/api/friends/search?q=zzfr_b`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, [{ username: names.bob, status: 'none' }]);
    const self = await get('alice', `/api/friends/search?q=${names.alice}`);
    assert.deepStrictEqual(self.body, []);
    // LIKE wildcards are literal
    const wild = await get('alice', '/api/friends/search?q=%25%25');
    assert.ok(wild.body.every(r => r.username.startsWith('%%')));
    // single char = exact match only, no enumeration
    const one = await get('alice', '/api/friends/search?q=z');
    assert.deepStrictEqual(one.body, []);
  });

  test('non-friend: cannot list, read, or see in feed', async () => {
    assert.strictEqual((await get('alice', `/api/friends/${names.bob}/sessions`)).status, 404);
    assert.strictEqual((await get('alice', `/api/friends/${names.bob}/sessions/${b1()}`)).status, 404);
    assert.strictEqual((await get('alice', `/api/friends/nosuchuser_${tag}/sessions`)).status, 404);
    const feed = await get('alice', '/api/feed');
    assert.strictEqual(feed.status, 200);
    assert.deepStrictEqual(feed.body.items, []);
  });

  test('pending request: no access for either side', async () => {
    const send = await request(app).post('/api/friends/requests').set(auth('alice')).send({ username: names.bob.toUpperCase() });
    assert.strictEqual(send.status, 200);
    assert.strictEqual(send.body.status, 'outgoing');
    // duplicate request
    assert.strictEqual((await request(app).post('/api/friends/requests').set(auth('alice')).send({ username: names.bob })).status, 409);

    const aliceView = await get('alice', '/api/friends');
    assert.deepStrictEqual(aliceView.body.outgoing.map(r => r.username), [names.bob]);
    const bobView = await get('bob', '/api/friends');
    assert.deepStrictEqual(bobView.body.incoming.map(r => r.username), [names.alice]);

    assert.strictEqual((await get('alice', `/api/friends/${names.bob}/sessions`)).status, 404);
    assert.strictEqual((await get('bob', `/api/friends/${names.alice}/sessions`)).status, 404);
    assert.strictEqual((await get('alice', `/api/friends/${names.bob}/sessions/${b1()}`)).status, 404);
    assert.deepStrictEqual((await get('alice', '/api/feed')).body.items, []);
  });

  test('only the addressee can accept', async () => {
    const r = await request(app).post(`/api/friends/requests/${names.bob}/accept`).set(auth('alice'));
    assert.strictEqual(r.status, 404);
    // a third party can't accept or cancel it either
    assert.strictEqual((await request(app).post(`/api/friends/requests/${names.alice}/accept`).set(auth('carol'))).status, 404);
    assert.strictEqual((await request(app).delete(`/api/friends/requests/${names.alice}`).set(auth('carol'))).status, 404);
  });

  test('accepted: finished sessions visible, active session never', async () => {
    const acc = await request(app).post(`/api/friends/requests/${names.alice}/accept`).set(auth('bob'));
    assert.strictEqual(acc.status, 200);

    const list = await get('alice', `/api/friends/${names.bob}/sessions`);
    assert.strictEqual(list.status, 200);
    const ids = list.body.items.map(s => s.id);
    assert.deepStrictEqual(ids, [`zzfr_${tag}_b3`, `zzfr_${tag}_b2`, b1()]);   // newest first
    assert.ok(!ids.includes(bActive()));
    assert.strictEqual(list.body.items[0].username, names.bob);
    assert.deepStrictEqual(list.body.items[0].exercises[0].sets[0].reps, 5);
    assert.strictEqual(list.body.nextCursor, null);

    const one = await get('alice', `/api/friends/${names.bob}/sessions/${b1()}`);
    assert.strictEqual(one.status, 200);
    assert.strictEqual(one.body.exercises[0].name, 'Squat');
    assert.strictEqual((await get('alice', `/api/friends/${names.bob}/sessions/${bActive()}`)).status, 404);

    // friendship is symmetric: bob can see alice (no sessions)
    const back = await get('bob', `/api/friends/${names.alice}/sessions`);
    assert.strictEqual(back.status, 200);
    assert.deepStrictEqual(back.body.items, []);

    // and a friend of bob can't use the route to read a NON-friend (carol)
    assert.strictEqual((await get('alice', `/api/friends/${names.carol}/sessions`)).status, 404);
    // nor read carol's session via bob's path
    assert.strictEqual((await get('alice', `/api/friends/${names.bob}/sessions/zzfr_${tag}_c1`)).status, 404);
  });

  test('feed: only friends, only finished, newest first, paginated', async () => {
    const p1 = await get('alice', '/api/feed?limit=2');
    assert.strictEqual(p1.status, 200);
    assert.deepStrictEqual(p1.body.items.map(s => [s.username, s.id]), [
      [names.bob, `zzfr_${tag}_b3`], [names.bob, `zzfr_${tag}_b2`],
    ]);
    assert.ok(p1.body.nextCursor);
    const p2 = await get('alice', `/api/feed?limit=2&before=${encodeURIComponent(p1.body.nextCursor)}`);
    assert.deepStrictEqual(p2.body.items.map(s => s.id), [b1()]);
    assert.strictEqual(p2.body.nextCursor, null);
    assert.strictEqual((await get('alice', '/api/feed?before=garbage')).status, 400);
  });

  test('friends cannot modify each other\'s sessions', async () => {
    const S = `/api/sessions/${b1()}`;
    const ex = `${b1()}_ex`;
    const set = `${b1()}_set`;
    assert.strictEqual((await get('alice', S)).status, 404);
    assert.strictEqual((await request(app).patch(`${S}/finish`).set(auth('alice'))).status, 404);
    assert.strictEqual((await request(app).post(`${S}/exercises`).set(auth('alice')).send({ id: 'zzx', name: 'X' })).status, 404);
    assert.strictEqual((await request(app).delete(`${S}/exercises/${ex}`).set(auth('alice'))).status, 404);
    assert.strictEqual((await request(app).post(`${S}/exercises/${ex}/sets`).set(auth('alice')).send({ id: 'zzs' })).status, 404);
    assert.strictEqual((await request(app).patch(`${S}/exercises/${ex}/sets/${set}`).set(auth('alice')).send({ reps: 99 })).status, 404);
    assert.strictEqual((await request(app).delete(`${S}/exercises/${ex}/sets/${set}`).set(auth('alice'))).status, 404);
    const after = await pool.query('SELECT reps FROM sets WHERE id = $1', [set]);
    assert.strictEqual(after.rows[0].reps, 5);
    // and the friends routes are read-only (no write verbs on session paths)
    assert.strictEqual((await request(app).delete(`/api/friends/${names.bob}/sessions/${b1()}`).set(auth('alice'))).status, 404);
    assert.strictEqual((await pool.query('SELECT 1 FROM sessions WHERE id = $1', [b1()])).rows.length, 1);
  });

  test('cannot cancel an accepted friendship via the request endpoint', async () => {
    assert.strictEqual((await request(app).delete(`/api/friends/requests/${names.bob}`).set(auth('alice'))).status, 404);
    assert.strictEqual((await get('alice', `/api/friends/${names.bob}/sessions`)).status, 200);
  });

  test('removed friend: access revoked for both sides', async () => {
    const del = await request(app).delete(`/api/friends/${names.alice}`).set(auth('bob'));
    assert.strictEqual(del.status, 200);
    assert.strictEqual((await get('alice', `/api/friends/${names.bob}/sessions`)).status, 404);
    assert.strictEqual((await get('alice', `/api/friends/${names.bob}/sessions/${b1()}`)).status, 404);
    assert.strictEqual((await get('bob', `/api/friends/${names.alice}/sessions`)).status, 404);
    assert.deepStrictEqual((await get('alice', '/api/feed')).body.items, []);
    assert.deepStrictEqual((await get('alice', '/api/friends')).body, { friends: [], incoming: [], outgoing: [] });
    assert.strictEqual((await request(app).delete(`/api/friends/${names.alice}`).set(auth('bob'))).status, 404);
  });

  test('decline and cancel remove pending requests', async () => {
    await request(app).post('/api/friends/requests').set(auth('alice')).send({ username: names.carol }).expect(200);
    await request(app).delete(`/api/friends/requests/${names.alice}`).set(auth('carol')).expect(200);   // decline
    assert.deepStrictEqual((await get('alice', '/api/friends')).body.outgoing, []);

    await request(app).post('/api/friends/requests').set(auth('alice')).send({ username: names.carol }).expect(200);
    await request(app).delete(`/api/friends/requests/${names.carol}`).set(auth('alice')).expect(200);   // cancel
    assert.deepStrictEqual((await get('carol', '/api/friends')).body.incoming, []);
    assert.strictEqual((await get('alice', `/api/friends/${names.carol}/sessions`)).status, 404);
  });

  test('requesting someone who already requested you accepts it', async () => {
    await request(app).post('/api/friends/requests').set(auth('carol')).send({ username: names.alice }).expect(200);
    const r = await request(app).post('/api/friends/requests').set(auth('alice')).send({ username: names.carol });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.status, 'friends');
    assert.strictEqual((await get('alice', `/api/friends/${names.carol}/sessions`)).body.items.length, 1);
  });

  test('request validation: self, unknown, missing', async () => {
    const post = (body) => request(app).post('/api/friends/requests').set(auth('alice')).send(body);
    assert.strictEqual((await post({ username: names.alice })).status, 400);
    assert.strictEqual((await post({ username: `nosuch_${tag}` })).status, 404);
    assert.strictEqual((await post({})).status, 400);
  });

  test('responses never include password hashes or user ids', async () => {
    const bodies = [
      (await get('alice', '/api/friends')).body,
      (await get('alice', '/api/friends/search?q=zzfr_')).body,
      (await get('alice', '/api/feed')).body,
      (await get('alice', `/api/friends/${names.carol}/sessions`)).body,
    ];
    const json = JSON.stringify(bodies);
    assert.ok(!/password|hash|user_id|userId|requester|addressee/i.test(json), json);
  });
});
