// pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'leave-tracker-api',
      script: 'src/server.js',
      // One process: live updates keep open streams in memory.
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '300M',
      env: { NODE_ENV: 'production' },
    },
  ],
};
