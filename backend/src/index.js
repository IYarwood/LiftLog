require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const app = require('./app');

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`LiftLog API running on port ${PORT}`);
});
