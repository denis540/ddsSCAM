'use strict';

const log = require('./logger');

function createNotifier({ token, chatId } = {}) {
  return async function notify(text) {
    log.info(`[notify] ${text}`);
    if (!token || !chatId) return;
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      });
    } catch (e) {
      log.warn('Telegram send failed:', e.message);
    }
  };
}

module.exports = { createNotifier };
