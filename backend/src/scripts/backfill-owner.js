async function backfillOwner(pool, usernameRaw) {
  if (!usernameRaw) {
    throw new Error('Usage: backfill-owner.js <username>');
  }
  const username = usernameRaw.toLowerCase();

  const userRes = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  const user = userRes.rows[0];
  if (!user) {
    throw new Error(`User "${username}" not found`);
  }

  const result = await pool.query(
    'UPDATE sessions SET user_id = $1 WHERE user_id IS NULL',
    [user.id]
  );
  return result.rowCount;
}

module.exports = { backfillOwner };

// CLI: node src/scripts/backfill-owner.js <username>
if (require.main === module) {
  require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
  const pool = require('../db/pool');
  const [, , username] = process.argv;
  backfillOwner(pool, username)
    .then((count) => { console.log(`Backfilled ${count} session(s) to "${username.toLowerCase()}"`); })
    .catch((err) => { console.error(err.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
