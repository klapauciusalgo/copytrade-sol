module.exports = {
  apps: [
    {
      name: 'copytrade-telegram',
      script: 'npx',
      args: 'tsx apps/telegram/src/index.ts',
      cwd: './',
      restart_delay: 3000,
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production'
      }
    },
    {
      name: 'copytrade-worker',
      script: 'npx',
      args: 'tsx apps/worker/src/index.ts',
      cwd: './',
      restart_delay: 3000,
      autorestart: true,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
