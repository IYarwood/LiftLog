// Editing FINISHED workouts: ownership, the edit window, validation, the edited
// marker, and leaderboards recomputing from edited data. Real test DB only;
// throwaway users prefixed "zzed_" are deleted afterwards (sessions cascade).
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
const { EDIT_WINDOW_DAYS } = require('../src/db/editWindow');

const tag = Math.random().toString(36).slice(2, 8);
const U = {};
let seq = 0;
const ago = (mins) => new Date(Date.now() - mins * 60e3);
const DAY = 24 * 60;

async function makeUser(key) {
  const username = `zzed_${key}_${tag}`;
  const r = await pool.query("INSERT INTO users (username, password_hash) VALUES ($1, 'x') RETURNING id", [username]);
  U[key] = { id: r.rows[0].id, username, token: signToken({ userId: r.rows[0].id, username }) };
}
// Returns { id, ex: { name: exId }, set: { name: [setIds] } }
async function makeSession(key, finishedAt, lifts) {
  const id = `zzed_${tag}_${++seq}`;
  await pool.query('INSERT INTO sessions (id, started_at, finished_at, user_id) VALUES ($1, $2, $3, $4)',
    [id, finishedAt ? new Date(finishedAt - 3600e3) : new Date(), finishedAt, U[key].id]);
  const out = { id, ex: {}, set: {} };
  for (const [i, [name, reps, weight]] of lifts.entries()) {
    if (!out.ex[name]) {
      out.ex[name] = `${id}_e${Object.keys(out.ex).length}`;
      out.set[name] = [];
      await pool.query('INSERT INTO session_exercises (id, session_id, name, position) VALUES ($1, $2, $3, 0)', [out.ex[name], id, name]);
    }
    const setId = `${id}_s${i}`;
    out.set[name].push(setId);
    await pool.query('INSERT INTO sets (id, session_exercise_id, reps, weight, saved_at, position) VALUES ($1, $2, $3, $4, $5, $6)',
      [setId, out.ex[name], reps, weight, finishedAt, i]);
  }
  return out;
}
const auth = (k) => ({ Authorization: `Bearer ${U[k].token}` });
const editedAt = async (id) => (await pool.query('SELECT edited_at FROM sessions WHERE id = $1', [id])).rows[0].edited_at;

describe('editing finished workouts (integration, real test DB)', { skip }, () => {
  let recent, old, active, lift;
  before(async () => {
    await pool.query("DELETE FROM users WHERE username LIKE 'zzed\\_%'");
    for (const k of ['owner', 'friend', 'stranger']) await makeUser(k);
    await pool.query("INSERT INTO friendships (requester_id, addressee_id, status, accepted_at) VALUES ($1, $2, 'accepted', NOW())",
      [U.owner.id, U.friend.id]);
    recent = await makeSession('owner', ago(2 * DAY), [['Bench Press', 5, 200], ['Bench Press', 5, 210], ['Row', 8, 100]]);
    old = await makeSession('owner', ago((EDIT_WINDOW_DAYS + 1) * DAY), [['Bench Press', 5, 190], ['Row', 8, 95]]);
    active = await makeSession('owner', null, [['Squat', 5, 100]]);
  });
  after(async () => {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [Object.values(U).map(u => u.id)]);
    await pool.end();
  });

  const setUrl = (s, name, i = 0) => `/api/sessions/${s.id}/exercises/${s.ex[name]}/sets/${s.set[name][i]}`;

  test('window is a 7-day constant; the session shape exposes editableUntil + editedAt', async () => {
    assert.strictEqual(EDIT_WINDOW_DAYS, 7);
    const r = await request(app).get(`/api/sessions/${recent.id}`).set(auth('owner'));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.editedAt, null);
    const until = new Date(r.body.editableUntil) - new Date(r.body.finishedAt);
    assert.strictEqual(until, 7 * 24 * 3600e3);
  });

  test('inside the window: edit a set, add a set, delete a set, remove an exercise; edited_at is stamped', async () => {
    let r = await request(app).patch(setUrl(recent, 'Bench Press')).set(auth('owner')).send({ reps: 6, weight: 205 });
    assert.strictEqual(r.status, 200);
    const st = (await pool.query('SELECT reps, weight FROM sets WHERE id = $1', [recent.set['Bench Press'][0]])).rows[0];
    assert.deepStrictEqual([st.reps, Number(st.weight)], [6, 205]);
    assert.ok(await editedAt(recent.id), 'edited_at set');

    r = await request(app).post(`/api/sessions/${recent.id}/exercises/${recent.ex['Bench Press']}/sets`).set(auth('owner')).send({ id: `zzed_${tag}_new` });
    assert.strictEqual(r.status, 200);
    r = await request(app).delete(`/api/sessions/${recent.id}/exercises/${recent.ex['Bench Press']}/sets/zzed_${tag}_new`).set(auth('owner'));
    assert.strictEqual(r.status, 200);
    r = await request(app).delete(`/api/sessions/${recent.id}/exercises/${recent.ex.Row}`).set(auth('owner'));
    assert.strictEqual(r.status, 200);

    const got = await request(app).get(`/api/sessions/${recent.id}`).set(auth('owner'));
    assert.ok(got.body.editedAt);
    assert.deepStrictEqual(got.body.exercises.map(e => e.name), ['Bench Press']);
    // the friend's feed shows the marker too
    const feed = await request(app).get('/api/feed').set(auth('friend'));
    assert.ok(feed.body.items.find(s => s.id === recent.id).editedAt);
  });

  test('validation is the same as live sets (400, nothing stored)', async () => {
    for (const body of [{ reps: -1 }, { reps: 2.5 }, { weight: 10000 }, { weight: 'abc' }]) {
      const r = await request(app).patch(setUrl(recent, 'Bench Press', 1)).set(auth('owner')).send(body);
      assert.strictEqual(r.status, 400, JSON.stringify(body));
    }
    const st = (await pool.query('SELECT reps, weight FROM sets WHERE id = $1', [recent.set['Bench Press'][1]])).rows[0];
    assert.deepStrictEqual([st.reps, Number(st.weight)], [5, 210]);
  });

  test('outside the window: every write is a 403 with a clear message, and nothing changes', async () => {
    const calls = [
      request(app).patch(setUrl(old, 'Bench Press')).set(auth('owner')).send({ weight: 500 }),
      request(app).delete(setUrl(old, 'Bench Press')).set(auth('owner')),
      request(app).post(`/api/sessions/${old.id}/exercises/${old.ex['Bench Press']}/sets`).set(auth('owner')).send({ id: `zzed_${tag}_x` }),
      request(app).delete(`/api/sessions/${old.id}/exercises/${old.ex.Row}`).set(auth('owner')),
      request(app).post(`/api/sessions/${old.id}/exercises`).set(auth('owner')).send({ id: `zzed_${tag}_ex`, name: 'Deadlift' }),
      request(app).delete(`/api/sessions/${old.id}`).set(auth('owner')),
    ];
    for (const r of await Promise.all(calls)) {
      assert.strictEqual(r.status, 403);
      assert.match(r.body.error, /Editing closed.*7 days/);
      assert.strictEqual(r.body.code, 'edit_window_closed');
    }
    const got = await request(app).get(`/api/sessions/${old.id}`).set(auth('owner'));
    assert.deepStrictEqual(got.body.exercises.map(e => [e.name, e.sets.map(s => s.weight)]), [['Bench Press', [190]], ['Row', [95]]]);
    assert.strictEqual(got.body.editedAt, null);
  });

  test('re-finishing an old workout does not move finished_at (no fresh window)', async () => {
    const before = (await pool.query('SELECT finished_at FROM sessions WHERE id = $1', [old.id])).rows[0].finished_at;
    const r = await request(app).patch(`/api/sessions/${old.id}/finish`).set(auth('owner'));
    assert.strictEqual(r.status, 200);
    const afterFin = (await pool.query('SELECT finished_at FROM sessions WHERE id = $1', [old.id])).rows[0].finished_at;
    assert.strictEqual(+afterFin, +before);
    assert.strictEqual((await request(app).patch(`/api/sessions/nope_${tag}/finish`).set(auth('owner'))).status, 404);
  });

  test('in-progress workouts are unaffected and never marked edited', async () => {
    const r = await request(app).patch(setUrl(active, 'Squat')).set(auth('owner')).send({ weight: 110 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(await editedAt(active.id), null);
  });

  test("a friend or stranger can't edit or delete (404)", async () => {
    for (const who of ['friend', 'stranger']) {
      assert.strictEqual((await request(app).patch(setUrl(recent, 'Bench Press')).set(auth(who)).send({ reps: 1 })).status, 404);
      assert.strictEqual((await request(app).delete(setUrl(recent, 'Bench Press')).set(auth(who))).status, 404);
      assert.strictEqual((await request(app).delete(`/api/sessions/${recent.id}/exercises/${recent.ex['Bench Press']}`).set(auth(who))).status, 404);
      assert.strictEqual((await request(app).delete(`/api/sessions/${recent.id}`).set(auth(who))).status, 404);
    }
    const st = (await pool.query('SELECT reps FROM sets WHERE id = $1', [recent.set['Bench Press'][0]])).rows[0];
    assert.strictEqual(st.reps, 6);
  });

  describe('leaderboards recompute from edited data', () => {
    before(async () => {
      // Baseline 3 weeks ago (outside the edit window): owner Deadlift 5×200,
      // friend holds the Deadlift crown with 290×1.
      await makeSession('owner', ago(21 * DAY), [['Deadlift', 5, 200]]);
      await makeSession('friend', ago(22 * DAY), [['Deadlift', 1, 270]]);   // backs up the 290 (crown guard)
      await makeSession('friend', ago(21 * DAY), [['Deadlift', 1, 290]]);
      lift = await makeSession('owner', ago(1), [['Deadlift', 5, 200]]);   // this week, no gain yet
    });

    test('editing a set changes points and the crown, and the crown shows "edited"', async () => {
      const pts = async () => {
        const b = (await request(app).get('/api/leaderboard/weekly').set(auth('owner'))).body;
        return b.entries.find(e => e.isYou).exercises.find(x => x.name === 'Deadlift');
      };
      assert.deepStrictEqual([(await pts()).points, (await pts()).status], [0, 'no-gain']);
      let crown = (await request(app).get('/api/leaderboard/strength/deadlift').set(auth('owner'))).body.entries[0];
      assert.strictEqual(crown.username, U.friend.username);

      // fix a "typo": 200 → 205 (+2.5% → 25 pts)
      assert.strictEqual((await request(app).patch(setUrl(lift, 'Deadlift')).set(auth('owner')).send({ weight: 205 })).status, 200);
      assert.strictEqual((await pts()).points, 25);

      // and a heavier single takes the crown
      const add = await request(app).post(`/api/sessions/${lift.id}/exercises/${lift.ex.Deadlift}/sets`).set(auth('owner')).send({ id: `zzed_${tag}_dl` });
      assert.strictEqual(add.status, 200);
      await request(app).patch(`/api/sessions/${lift.id}/exercises/${lift.ex.Deadlift}/sets/zzed_${tag}_dl`).set(auth('owner')).send({ reps: 1, weight: 300 });
      crown = (await request(app).get('/api/leaderboard/strength/deadlift').set(auth('owner'))).body.entries[0];
      assert.deepStrictEqual([crown.username, crown.weight, crown.edited], [U.owner.username, 300, true]);
      const list = (await request(app).get('/api/leaderboard/strength').set(auth('friend'))).body;
      assert.strictEqual(list.exercises.find(x => x.name === 'Deadlift').holder.edited, true);
    });

    test('deleting a workout inside the window removes it from the boards', async () => {
      assert.strictEqual((await request(app).delete(`/api/sessions/${lift.id}`).set(auth('owner'))).status, 200);
      assert.strictEqual((await request(app).get(`/api/sessions/${lift.id}`).set(auth('owner'))).status, 404);
      const crown = (await request(app).get('/api/leaderboard/strength/deadlift').set(auth('owner'))).body.entries[0];
      assert.strictEqual(crown.username, U.friend.username);
    });
  });
});
