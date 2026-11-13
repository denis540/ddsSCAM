'use strict';

const log = require('./logger');
const R = require('./report');

const KEYBOARD = {
  keyboard: [
    [{ text: '📊 Статус' }, { text: '📈 Позиції' }, { text: '🔝 Топ' }],
    [{ text: '💰 Звіт' }, { text: '📜 Історія' }, { text: '⚙️ Налаштування' }],
    [{ text: '⏸ Пауза' }, { text: '▶️ Старт' }, { text: '❓ Допомога' }],
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
};

const HELP = `Команди:
/status — стан бота і прибуток
/positions — відкриті позиції з PnL
/top — найкращі можливості зараз
/report — звіт за сьогодні (автоматично щодня о reporttime)
/history — останні закриті угоди
/settings — усі налаштування
/set <параметр> <значення> — змінити налаштування
/qty — кількості монет для входу
/qty BTC 0.01 — входити рівно 0.01 BTC (0 = прибрати монету)
/close <номер> — закрити пару (номер з /positions)
/closeall — закрити всі пари
/pause — не відкривати нові позиції (відкриті супроводжуються)
/resume — відновити входи

Приклади:
/set minspread 0.1   — входити тільки якщо спред фандінгу > 0.1% за 8 год
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
          this.handle(msg.text.trim(), chatId).catch((e) => this.send(`❌ ${e.message}`, chatId));
        }
      } catch (e) {
        log.warn(`Telegram polling: ${e.message}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  async handle(text, chatId) {
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
        return reply(R.formatPositions(state, this.ctx.getRates(), cfg.quote));
      case '/top':
        return reply(R.formatOpps(this.ctx.getOpps(), 10));
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
