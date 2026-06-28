module.exports = {
  apps: [
    {
      name: 'liftlog',
      script: './backend/src/index.js',
      cwd: '/root/work/LiftLog',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
      restart_delay: 3000,
      max_restarts: 10,
    },
  ],
};
