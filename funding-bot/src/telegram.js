'use strict';

const log = require('./logger');
const R = require('./report');
const { META, normalizeName, SUPPORTED } = require('./exchanges-meta');
const { mask } = require('./keys');

const KEYBOARD = {
  keyboard: [
    [{ text: '📊 Статус' }, { text: '📈 Позиції' }, { text: '🔝 Топ' }],
    [{ text: '💰 Звіт' }, { text: '📜 Історія' }, { text: '⚙️ Налаштування' }],
    [{ text: '🏦 Біржі' }, { text: '💵 Баланс' }, { text: '❓ Допомога' }],
    [{ text: '⏸ Пауза' }, { text: '▶️ Старт' }],
  ],
  resize_keyboard: true,
};

const BUTTONS = {
  '📊 Статус': '/status',
  '📈 Позиції': '/positions',
  '🔝 Топ': '/top',
  '💰 Звіт': '/report',
  '📜 Історія': '/history',
  '⚙️ Налаштування': '/settings',
  '⏸ Пауза': '/pause',
  '▶️ Старт': '/resume',
  '❓ Допомога': '/help',
  '🏦 Біржі': '/exchanges',
  '💵 Баланс': '/balance',
};

const HELP = `Команди:
/status — стан бота і прибуток
/positions — відкриті позиції з PnL
/top — найближчі вигідні виплати фандінгу
/report — звіт за сьогодні (автоматично щодня о reporttime)
/history — останні закриті угоди
/settings — усі налаштування
/set <параметр> <значення> — змінити налаштування
/qty — кількості монет для входу
/qty BTC 0.01 — входити рівно 0.01 BTC (0 = прибрати монету)
/close <номер> — закрити пару (номер з /positions)
/closeall — закрити всі пари
/exchanges — біржі: підключення, кількість монет, ключі
/balance — баланси і відкриті позиції на біржах
/setkey <біржа> <apiKey> <secret> [passphrase] — додати API-ключ
/delkey <біржа> — видалити ключ, доданий через Telegram
/pause — не відкривати нові позиції (відкриті супроводжуються)
/resume — відновити входи

Як працює: бот заходить за ~2 хв до виплати фандінгу (SHORT там, де ставка вища,
LONG там, де нижча), отримує виплату(и) і виходить через ~2 хв після
або одразу, як ціни на біржах зійдуться.

Приклади:
/set minfunding 0.5  — входити, лише якщо фандінг за виплату > 0.5% (напр. OKX 3% − Binance 1% = 2%)
/set minprofit 0.2   — і чистий профіт після комісій > 0.2%
/set entrybefore 120 — заходити за 120 с до виплати
/set exitafter 120   — виходити через 120 с після виплати
/set converge 0.05   — ціни «зійшлись», якщо різниця ≤ 0.05%
/set maxwindow 0     — лише одна виплата (або одночасні), без утримання між різними часами
/set maxpos 5        — макс. 5 пар одночасно
/set leverage 3      — плече x3 для нових позицій
/set sizemode coins  — вхід кількістю монет (/qty)
/set sizemode usdt   — вхід сумою, /set usdt 50
/set reporttime 23:55`;

class Telegram {
  constructor({ token, chatIds }) {
    this.token = token;
    this.chatIds = (chatIds || []).map(String);
    this.enabled = Boolean(token && this.chatIds.length);
    this.offset = 0;
    this.handlers = null;
    this.stopped = false;
  }

  async api(method, body) {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`${method}: ${json.description}`);
    return json.result;
  }

  async send(text, chatId) {
    log.info(`[tg] ${text.replace(/\n/g, ' | ')}`);
    if (!this.enabled) return;
    const targets = chatId ? [String(chatId)] : this.chatIds;
    // Ліміт Telegram — 4096 символів; ріжемо по рядках
    const chunks = [];
    let cur = '';
    for (const line of text.split('\n')) {
      if ((cur + line).length > 3900) {
        chunks.push(cur);
        cur = '';
      }
      cur += `${line}\n`;
    }
    if (cur.trim()) chunks.push(cur);
    for (const id of targets) {
      for (const chunk of chunks) {
        try {
          await this.api('sendMessage', { chat_id: id, text: chunk, disable_web_page_preview: true, reply_markup: KEYBOARD });
        } catch (e) {
          log.warn(`Telegram send failed: ${e.message}`);
        }
      }
    }
  }

  /** Long polling команд. ctx: { cfg, settings, state, trader, getRates, getOpps, getLastScanAt } */
  async start(ctx) {
    if (!this.enabled) {
      log.warn('Telegram вимкнено: задайте TELEGRAM_BOT_TOKEN і TELEGRAM_CHAT_ID');
      return;
    }
    this.ctx = ctx;
    try {
      await this.api('setMyCommands', {
        commands: [
          ['status', 'Стан і прибуток'], ['positions', 'Відкриті позиції'], ['top', 'Найкращі можливості'],
          ['report', 'Звіт за сьогодні'], ['history', 'Закриті угоди'], ['settings', 'Налаштування'],
          ['qty', 'Кількості монет'], ['pause', 'Пауза входів'], ['resume', 'Відновити входи'], ['help', 'Допомога'],
        ].map(([command, description]) => ({ command, description })),
      });
    } catch (e) {
      log.warn(`setMyCommands: ${e.message}`);
    }
    this.poll();
  }

  async poll() {
    while (!this.stopped) {
      try {
        const updates = await this.api('getUpdates', { offset: this.offset, timeout: 25, allowed_updates: ['message'] });
        for (const u of updates) {
          this.offset = u.update_id + 1;
          const msg = u.message;
          if (!msg || !msg.text) continue;
          const chatId = String(msg.chat.id);
          if (!this.chatIds.includes(chatId)) {
            log.warn(`Telegram: ігнорую повідомлення з чужого чату ${chatId}`);
            continue;
          }
          this.handle(msg.text.trim(), chatId, msg.message_id).catch((e) => this.send(`❌ ${e.message}`, chatId));
        }
      } catch (e) {
        log.warn(`Telegram polling: ${e.message}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  async handle(text, chatId, messageId) {
    const reply = (t) => this.send(t, chatId);
    const { cfg, settings, state, trader } = this.ctx;
    const line = BUTTONS[text] || text;
    const [rawCmd, ...args] = line.split(/\s+/);
    const cmd = rawCmd.toLowerCase().replace(/@.*$/, '');

    switch (cmd) {
      case '/start':
      case '/help':
        return reply(HELP);
      case '/status':
        return reply(R.formatStatus(cfg, state, this.ctx.getRates(), this.ctx.getLastScanAt()));
      case '/positions':
        return reply(R.formatPositions(state, this.ctx.getRates(), cfg));
      case '/top':
        return reply(R.formatOpps(this.ctx.getOpps(), cfg, 10, this.ctx.exchanges || {}));
      case '/report':
        return reply(R.formatDailyReport(cfg, state, state.dayKey(), this.ctx.getRates()));
      case '/history':
        return reply(R.formatHistory(state, Number(args[0]) || 10, cfg.quote));
      case '/settings':
        return reply(`⚙️ Налаштування (змінити: /set <параметр> <значення>)\n\n${settings.describe()}\n\nКількості монет: /qty`);
      case '/set': {
        if (args.length < 2) return reply('Формат: /set <параметр> <значення>. Список: /settings');
        const v = settings.set(args[0], args.slice(1).join(','));
        let note = '';
        if (args[0].toLowerCase() === 'leverage') note = '\n(застосовується до нових позицій)';
        if (args[0].toLowerCase() === 'sizemode' && cfg.sizeMode === 'coins' && !Object.keys(cfg.coinQty).length) {
          note = '\n⚠️ Задайте кількості: /qty BTC 0.01';
        }
        return reply(`✅ ${args[0].toLowerCase()} = ${v}${note}`);
      }
      case '/qty': {
        if (args.length === 0) {
          const list = Object.entries(cfg.coinQty).map(([c, q]) => `${c}: ${q}`);
          return reply(
            `Кількості монет для входу (режим: ${cfg.sizeMode}):\n${list.length ? list.join('\n') : '— не задано'}\n\n` +
              'Задати: /qty BTC 0.01  |  прибрати: /qty BTC 0\n' +
              'У режимі coins бот торгує ЛИШЕ монети зі списку і входить/виходить рівно цією кількістю.'
          );
        }
        if (args.length < 2) return reply('Формат: /qty <монета> <кількість>');
        const c = settings.setQty(args[0], args[1]);
        return reply(cfg.coinQty[c] ? `✅ ${c}: вхід ${cfg.coinQty[c]} ${c}` : `✅ ${c} прибрано зі списку`);
      }
      case '/exchanges': {
        const { all, initErrors, keys } = this.ctx;
        const lines = SUPPORTED.concat(Object.keys(all).filter((id) => !META[id])).map((id) => {
          const ex = all[id];
          const src = keys.source(id);
          const keyTxt = src ? `🔑 ${mask(keys.get(id).apiKey)} (${src})` : '— без ключа';
          if (!ex) return `⚪ ${META[id] ? META[id].title : id}: вимкнена (EXCHANGES)`;
          if (!ex.ready) return `🔴 ${ex.title}: не підключилась (${(initErrors[id] || '').slice(0, 80)}) ${keyTxt}`;
          return `🟢 ${ex.title}: ${ex.perpSymbols().length} монет, ${keyTxt}`;
        });
        return reply(
          `🏦 Біржі (${cfg.mode.toUpperCase()}):\n${lines.join('\n')}\n\n` +
            `Дані (ставки, стакани) беруться з усіх 🟢. ${cfg.mode === 'live' ? 'Торгівля — лише між біржами з 🔑.' : 'У PAPER ордери не ставляться.'}\n` +
            'Додати ключ: /setkey binance <apiKey> <secret>\nOKX/Bitget/KuCoin: /setkey okx <apiKey> <secret> <passphrase>'
        );
      }
      case '/balance': {
        const { exchanges } = this.ctx;
        const withKeys = Object.values(exchanges).filter((e) => e.hasKeys);
        if (!withKeys.length) return reply('Немає жодної біржі з API-ключем. /setkey');
        const parts = await Promise.all(
          withKeys.map(async (ex) => {
            try {
              const [b, ps] = await Promise.all([ex.balanceSummary(), ex.openPositions().catch(() => [])]);
              const pos = ps.map((p) => `   ${p.canonical.split('/')[0]} ${p.side} ${p.contracts} контр. PnL ${(+(p.unrealizedPnl || 0).toFixed(4))}`).join('\n');
              return `${ex.title}: вільно ${b.free.toFixed(2)} / всього ${b.total.toFixed(2)} ${b.currency}${pos ? `\n${pos}` : ''}`;
            } catch (e) {
              return `${ex.title}: ❌ ${e.message.slice(0, 120)}`;
            }
          })
        );
        return reply(`💵 Баланси ф'ючерсних рахунків:\n\n${parts.join('\n\n')}`);
      }
      case '/setkey': {
        // Повідомлення з ключем одразу видаляємо з чату
        if (messageId) this.api('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {});
        const id = normalizeName(args[0]);
        const meta = META[id];
        const { all, exchanges, keys } = this.ctx;
        if (!all[id]) return reply(`Біржа "${args[0]}" не увімкнена. Доступні: ${Object.keys(all).join(', ')}`);
        if (args.length < 3) return reply(`Формат: /setkey ${id} <apiKey> <secret>${meta && meta.password ? ' <passphrase>' : ''}`);
        if (meta && meta.password && !args[3]) return reply(`${meta.title} потребує passphrase: /setkey ${id} <apiKey> <secret> <passphrase>`);
        const creds = { apiKey: args[1], secret: args[2], password: args[3] };
        const ex = all[id];
        const prev = keys.get(id);
        ex.setCredentials(creds);
        try {
          if (!ex.ready) await ex.init();
          exchanges[id] = ex;
          const b = await ex.balanceSummary();
          keys.set(id, creds);
          return reply(`✅ Ключ ${ex.title} ${mask(creds.apiKey)} збережено і перевірено. Баланс: ${b.free.toFixed(2)} ${b.currency}\n(повідомлення з ключем видалено з чату)`);
        } catch (e) {
          ex.setCredentials(prev);
          return reply(`❌ Ключ ${ex.title} не працює: ${e.message.slice(0, 200)}\nПідказка: ${(meta && meta.keyHint) || ''}`);
        }
      }
      case '/delkey': {
        const id = normalizeName(args[0]);
        const { all, keys } = this.ctx;
        if (!all[id]) return reply('Формат: /delkey <біржа>');
        keys.remove(id);
        all[id].setCredentials(keys.get(id)); // повертаємось до ключа з .env, якщо він є
        return reply(`🗑 Ключ ${all[id].title}, доданий через Telegram, видалено.${keys.source(id) ? ' Діє ключ з .env.' : ''}`);
      }
      case '/pause':
        settings.setPaused(true);
        return reply('⏸ Пауза: нові позиції не відкриваються. Відкриті супроводжуються і закриваються за правилами.');
      case '/resume':
        settings.setPaused(false);
        return reply('▶️ Входи відновлено');
      case '/close': {
        const n = Number(args[0]);
        const pos = state.positions[n - 1];
        if (!pos) return reply('Немає такої позиції. Номери: /positions');
        await reply(`Закриваю ${pos.symbol} ${pos.shortEx}/${pos.longEx}...`);
        await trader.withLock(() => trader.closePair(pos, 'закрито вручну через Telegram'));
        return undefined;
      }
      case '/closeall': {
        if (!state.positions.length) return reply('Відкритих позицій немає');
        if (args[0] !== 'yes') return reply(`Закрити всі ${state.positions.length} пар? Підтвердіть: /closeall yes`);
        await trader.withLock(async () => {
          for (const pos of [...state.positions]) await trader.closePair(pos, 'закрито вручну (closeall)');
        });
        return undefined;
      }
      default:
        return reply('Невідома команда. /help');
    }
  }
}

module.exports = { Telegram };
