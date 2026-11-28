require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { TIMEZONE, checkTimezone } = require('./leaderboard/points');

// Fail fast on a bad LEADERBOARD_TZ: otherwise the server starts fine and
// every weekly/monthly leaderboard request is a 500.
try {
  checkTimezone(TIMEZONE);
} catch (err) {
  console.error(`LiftLog API not started: ${err.message}`);
  process.exit(1);
}

const app = require('./app');

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`LiftLog API running on port ${PORT}`);
});
