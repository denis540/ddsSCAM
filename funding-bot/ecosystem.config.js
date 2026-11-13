// pm2: автоперезапуск бота при падінні і після перезавантаження сервера.
//   npm i -g pm2
//   pm2 start ecosystem.config.js
//   pm2 save && pm2 startup      # автозапуск після ребуту сервера
//   pm2 logs funding-bot         # логи
module.exports = {
  apps: [
    {
      name: 'funding-bot',
      script: 'src/index.js',
      cwd: __dirname,
      autorestart: true,
      restart_delay: 5000, // 5 с між перезапусками
      max_restarts: 50,
      min_uptime: '30s',
      kill_timeout: 15000, // дати боту завершити поточний цикл
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      time: true,
      env: { NODE_ENV: 'production' },
    },
  ],
};
