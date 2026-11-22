const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(path.resolve(__dirname, '../schema.sql'), 'utf8');

test('schema creates users table idempotently', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS users/);
  assert.match(sql, /username TEXT NOT NULL UNIQUE/);
  assert.match(sql, /password_hash TEXT NOT NULL/);
});

test('schema adds nullable user_id to sessions, idempotently and indexed', () => {
  assert.match(sql, /ALTER TABLE sessions\s+ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions\(user_id\)/);
});

test('schema creates friendships table idempotently', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS friendships/);
  assert.match(sql, /requester_id INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(sql, /addressee_id INTEGER NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(sql, /CHECK \(status IN \('pending', 'accepted'\)\)/);
  assert.match(sql, /CHECK \(requester_id <> addressee_id\)/);
});

test('schema enforces one friendship row per unordered pair, idempotently', () => {
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_friendships_pair\s+ON friendships \(LEAST\(requester_id, addressee_id\), GREATEST\(requester_id, addressee_id\)\)/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_friendships_addressee/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_sessions_user_finished/);
});

// Split a SQL file into statements: strip -- comments, split on ';' but not
// inside a $$ ... $$ (DO block) body.
function statements(text) {
  const parts = text.replace(/--.*$/gm, '').split(/(\$\$[\s\S]*?\$\$)/);
  const out = [];
  let cur = '';
  for (const p of parts) {
    if (p.startsWith('$$')) { cur += p; continue; }
    const pieces = p.split(';');
    cur += pieces.shift();
    for (const piece of pieces) { out.push(cur); cur = piece; }
  }
  out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}
const norm = (s) => s.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim();

// Every migration must be idempotent and mirrored in schema.sql.
for (const [file, minStmts] of [
  ['2026-11-21-friends.sql', 4],
  ['2026-11-22-exercise-name-ci-unique.sql', 2],
  ['2026-11-23-session-edited-at.sql', 1],
]) {
  test(`${file} matches schema.sql and is idempotent`, () => {
    const mig = fs.readFileSync(path.resolve(__dirname, '../migrations', file), 'utf8');
    const stmts = statements(mig);
    assert.ok(stmts.length >= minStmts, `expected >= ${minStmts} statements, got ${stmts.length}`);
    for (const stmt of stmts) assert.ok(norm(sql).includes(norm(stmt)), `schema.sql is missing: ${stmt.slice(0, 60)}`);
    for (const stmt of stmts) {
      if (/^DO \$\$/.test(stmt)) continue;          // read-only guard block
      assert.match(stmt, /IF NOT EXISTS/);
    }
  });
}

test('schema enforces case-insensitive unique exercise names, guarded and idempotent', () => {
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_exercises_name_lower ON exercises \(lower\(name\)\)/);
  assert.match(sql, /RAISE EXCEPTION 'exercises has names that differ only by case/);
  // The guard + index come before the seed, and the seed must skip case
  // variants too (a targeted ON CONFLICT (name) would error on the lower index).
  assert.ok(sql.indexOf('idx_exercises_name_lower') < sql.indexOf('INSERT INTO exercises'));
  assert.doesNotMatch(sql, /ON CONFLICT \(name\)/);
});
