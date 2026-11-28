// LEADERBOARD_TZ is validated at startup (p-liftlog-43656c): a bad zone stops
// the server with a clear message instead of 500ing every leaderboard request.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkTimezone } = require('../src/leaderboard/points');

test('checkTimezone accepts IANA zones', () => {
  for (const tz of ['America/New_York', 'Europe/London', 'UTC', 'Asia/Kolkata']) {
    assert.strictEqual(checkTimezone(tz), tz);
  }
});

test('checkTimezone rejects anything else with a clear message', () => {
  for (const tz of ['Not/AZone', 'America/NewYork', 'EST+5', ' UTC', '', '   ', undefined]) {
    assert.throws(() => checkTimezone(tz), (err) => {
      assert.match(err.message, /Invalid LEADERBOARD_TZ/);
      assert.match(err.message, /IANA/);
      return true;
    }, String(tz));
  }
});

// Starts src/index.js for real. With a bad zone it must exit 1 before
// listening; PORT=0 so a (wrongly) started server wouldn't clash, and the
// timeout kills it if it does start.
function startServer(tz) {
  return spawnSync(process.execPath, [path.resolve(__dirname, '../src/index.js')], {
    env: { ...process.env, LEADERBOARD_TZ: tz, PORT: '0', JWT_SECRET: process.env.JWT_SECRET || 'test-secret' },
    encoding: 'utf8',
    timeout: 3000,
  });
}

test('the server refuses to start with an invalid LEADERBOARD_TZ', () => {
  const r = startServer('Mars/Olympus_Mons');
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /LiftLog API not started: Invalid LEADERBOARD_TZ "Mars\/Olympus_Mons"/);
  assert.doesNotMatch(r.stdout, /running on port/);
});

test('the server starts with a valid LEADERBOARD_TZ', () => {
  const r = startServer('Europe/Berlin');   // killed by the timeout once it is up
  assert.match(r.stdout, /LiftLog API running on port/, r.stderr);
});
