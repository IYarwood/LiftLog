module.exports = {
  apps: [
    {
      name: 'liftlog',
      script: './backend/src/index.js',
      cwd: '/var/www/liftlog',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
      restart_delay: 3000,
      max_restarts: 10,
    },
  ],
};
