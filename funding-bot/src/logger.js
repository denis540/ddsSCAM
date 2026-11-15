'use strict';

/**
 * Журнал: у консоль і у файл logs/bot-YYYY-MM-DD.log (новий файл щодня).
 * Файл можна надіслати розробнику: URL-параметри і схожі на ключі рядки прибираються.
 * Вимкнути запис у файл: LOG_TO_FILE=false. У тестах (node --test) файл не пишеться.
 */
const fs = require('fs');
const path = require('path');
const util = require('util');

// Час у журналі — у часовому поясі TIMEZONE (як у Telegram), а не UTC
const TZ = process.env.TIMEZONE || 'Europe/Kyiv';
const ts = () => {
  try {
    return new Date().toLocaleString('sv-SE', { timeZone: TZ, hour12: false });
  } catch {
    return new Date().toISOString().replace('T', ' ').slice(0, 19);
  }
};
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, '..', 'logs');
const toFile =
  String(process.env.LOG_TO_FILE || 'true').toLowerCase() !== 'false' &&
  !process.argv.includes('--test') &&
  !process.execArgv.some((a) => a.startsWith('--test')) &&
  process.env.NODE_TEST_CONTEXT === undefined;

function sanitize(text) {
  return String(text)
    .replace(/(https?:\/\/[^\s?"']+)\?[^\s"']*/g, '$1?…')
    .replace(/((?:api[-_ ]?key|apikey|access[-_ ]?key(?:id)?|secret|signature|sign|passphrase|password|token)["':= ]+)[A-Za-z0-9+/=_-]{8,}/gi, '$1***');
}

let failed = false;
function writeFile(line) {
  if (!toFile || failed) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, `bot-${ts().slice(0, 10)}.log`), `${sanitize(line)}\n`);
  } catch (e) {
    failed = true; // не заважаємо роботі бота, якщо диск недоступний
    console.error(`[${ts()}] ERROR журнал у файл вимкнено: ${e.message}`);
  }
}

function make(level, stream) {
  return (...a) => {
    const line = `[${ts()}] ${level} ${util.format(...a)}`;
    stream(line);
    writeFile(line);
  };
}

module.exports = {
  info: make('INFO ', console.log),
  warn: make('WARN ', console.warn),
  error: make('ERROR', console.error),
  debug: (...a) => process.env.DEBUG && make('DEBUG', console.log)(...a),
  /** Лише у файл (напр. підсумок кожного скану, щоб не засмічувати консоль). */
  file: (...a) => writeFile(`[${ts()}] INFO  ${util.format(...a)}`),
};
