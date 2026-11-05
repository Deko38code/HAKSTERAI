// HaksterAi server — pm2 ecosystem (Dell, mirrored from Mint's haksterAi-fix.config.cjs)
module.exports = {
  apps: [{
    name: 'hakster',
    script: 'bash',
    args: ['-c', 'npm run server'],
    cwd: '/home/ghost/haksterAi',
    env: {
      HOME: '/home/ghost',
      USER: 'ghost',
      LOGNAME: 'ghost'
    },
    max_memory_restart: '1G',
    autorestart: true,
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
};
