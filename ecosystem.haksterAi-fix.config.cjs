module.exports = {
  apps: [
    {
      name: 'haksterAi',
      script: 'bash',
      args: ['-c', 'npm run server'],
      cwd: '/home/ghost/haksterAi',
      env: {
        HOME: '/home/ghost',
        USER: 'ghost',
        LOGNAME: 'ghost'
      }
    }
  ]
};
