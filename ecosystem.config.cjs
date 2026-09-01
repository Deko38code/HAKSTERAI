module.exports = {
  apps: [
    {
      name: 'haksterAi',
      script: 'bash',
      args: ['-c', 'npm run server'],
      cwd: '/home/ghost/haksterAi',
      node_args: '--max-old-space-size=2048',
      max_memory_restart: '1800M',
      env: {
        HOME: '/home/ghost',
        USER: 'ghost',
        LOGNAME: 'ghost',
        // System node22 — server/node_modules/better-sqlite3 is built for ABI 127.
        // nvm node24 (ABI 137) crashloops with ERR_DLOPEN_FAILED.
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        NODE_OPTIONS: '--max-old-space-size=2048'
      }
    }
  ]
};
