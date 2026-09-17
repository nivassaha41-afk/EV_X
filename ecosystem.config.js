module.exports = {
  apps: [
    {
      name: 'ev-server',
      script: 'server.js',
      cwd: __dirname,
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      env: {
        NODE_ENV: 'production',
        PORT: 8080
      }
    }
  ]
};
