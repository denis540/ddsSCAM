'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Захист від двох копій бота на одному сервері: дві копії торгували б одним рахунком
 * (подвійні входи, плутанина з позиціями). Файл-замок з PID; «мертвий» замок (процесу вже немає)
 * перехоплюється — тож pm2/systemd після падіння стартують нормально.
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // процес є, але чужий
  }
}

function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const pid = Number(String(fs.readFileSync(file, 'utf8')).trim());
    if (pid && pid !== process.pid && isAlive(pid)) {
      throw new Error(`бот уже запущено (PID ${pid}, ${file}). Друга копія торгувала б тим самим рахунком — зупиніть першу або видаліть замок, якщо впевнені, що вона не працює.`);
    }
  }
  fs.writeFileSync(file, String(process.pid));
  const release = () => {
    try {
      if (fs.existsSync(file) && String(fs.readFileSync(file, 'utf8')).trim() === String(process.pid)) fs.unlinkSync(file);
    } catch {
      /* ігноруємо */
    }
  };
  process.on('exit', release);
  return release;
}

module.exports = { acquireLock, isAlive };
