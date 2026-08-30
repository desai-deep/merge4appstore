module.exports = {
  apps: [{
    name: 'merge4appstore-webhooks',
    script: 'webhook-server.js',
    cwd: __dirname,
    autorestart: true,
  }],
};
