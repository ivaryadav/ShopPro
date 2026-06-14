module.exports = {
  apps: [{
    name: 'shoperpro',
    script: 'index.js',
    cwd: '/home/YOUR_CPANEL_USER/shoperpro/server',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
    },
    error_file: '/home/YOUR_CPANEL_USER/logs/shoperpro-error.log',
    out_file:   '/home/YOUR_CPANEL_USER/logs/shoperpro-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
