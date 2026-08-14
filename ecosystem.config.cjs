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
        NODE_OPTIONS: '--max-old-space-size=2048'
      }
    }
  ]
};
