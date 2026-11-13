'use strict';

const log = require('./logger');
const R = require('./report');
const { META, normalizeName, SUPPORTED } = require('./exchanges-meta');
const { SCHEMA, display } = require('./settings');
const { mask } = require('./keys');
const { clock, getClockOffset } = require('./time');

/** Усі команди — одне джерело для меню Telegram (кнопка «Меню» біля поля вводу) і для /help. */
const COMMANDS = [
  ['Основне', [
    ['menu', 'Головне меню з кнопками'],
    ['status', 'Стан бота і прибуток'],
    ['positions', 'Відкриті позиції, виплати, PnL'],
    ['top', 'Найближчі вигідні виплати фандінгу'],
    ['report', 'Звіт за сьогодні'],
    ['history', 'Останні закриті угоди'],
    ['balance', 'Баланси і позиції на біржах'],
  ]],
  ['Біржі та ключі', [
    ['exchanges', 'Біржі: підключення, ключі'],
    ['setkey', 'Додати ключ: /setkey okx KEY SECRET [PASSPHRASE]'],
    ['delkey', 'Видалити ключ: /delkey okx'],
  ]],
  ['Монети', [
    ['coin', 'Перевірити монету: /coin PEPE'],
    ['coinsbad', 'Монети, які на різних біржах — різні'],
    ['coinban', 'Заборонити монету: /coinban X [біржа]'],
    ['coinok', 'Довіряти монеті: /coinok X'],
    ['coinreset', 'Скинути ручне рішення: /coinreset X'],
    ['qty', 'Кількість монет для входу: /qty BTC 0.01'],
  ]],
  ['Захист коштів', [
    ['safety', 'Стан захисту: стопи, ліміти, запобіжники'],
    ['reconcile', 'Звірити позиції бота з біржами зараз'],
    ['selftest', 'Самоперевірка бірж (/selftest full — з мінімальною угодою)'],
    ['unblock', 'Зняти блокування біржі: /unblock okx'],
  ]],
  ['Аналітика', [
    ['stats', 'Статистика по біржах і монетах, проковзування'],
    ['backtest', 'Перевірка стратегії на історії: /backtest 7'],
    ['export', 'Угоди у файл CSV: /export 30'],
  ]],
  ['Налаштування і керування', [
    ['settings', 'Усі налаштування (змінювати кнопками)'],
    ['set', 'Змінити: /set minfunding 0.5'],
    ['pause', 'Пауза: не відкривати нові позиції'],
    ['resume', 'Відновити входи'],
    ['close', 'Закрити пару: /close 1'],
    ['closeall', 'Закрити всі пари'],
    ['help', 'Шпаргалка по командах'],
  ]],
];

const HELP =
  '📖 Команди (не обов\'язково запам\'ятовувати: натисніть «🏠 Меню» або кнопку «Меню» ☰ біля поля вводу)\n\n' +
  COMMANDS.map(([title, list]) => `${title}:\n${list.map(([c, d]) => `/${c} — ${d}`).join('\n')}`).join('\n\n') +
  '\n\nЯк працює: бот заходить за ~2 хв до виплати фандінгу (SHORT там, де ставка вища, LONG там, де нижча), ' +
  'отримує виплату і виходить через ~2 хв після або одразу, як ціни на біржах зійдуться.';

const KEYBOARD = {
  keyboard: [
    [{ text: '🏠 Меню' }, { text: '📊 Статус' }, { text: '📈 Позиції' }],
    [{ text: '🔝 Топ' }, { text: '💰 Звіт' }, { text: '💵 Баланс' }],
    [{ text: '⚙️ Налаштування' }, { text: '🏦 Біржі' }, { text: '🪙 Монети' }],
    [{ text: '⏸ Пауза' }, { text: '▶️ Старт' }, { text: '❓ Команди' }],
  ],
  resize_keyboard: true,
};

const BUTTONS = {
  '🏠 Меню': '/menu',
  '📊 Статус': '/status',
  '📈 Позиції': '/positions',
  '🔝 Топ': '/top',
  '💰 Звіт': '/report',
  '📜 Історія': '/history',
  '⚙️ Налаштування': '/settings',
  '⏸ Пауза': '/pause',
  '▶️ Старт': '/resume',
  '❓ Команди': '/help',
  '❓ Допомога': '/help',
  '🏦 Біржі': '/exchanges',
  '💵 Баланс': '/balance',
  '🪙 Монети': '/coins',
};

const btn = (text, data) => ({ text, callback_data: data });
const inline = (rows) => ({ inline_keyboard: rows });

const MAIN_MENU = inline([
  [btn('📊 Статус', 'c:/status'), btn('📈 Позиції', 'c:/positions')],
  [btn('🔝 Топ виплат', 'c:/top'), btn('💰 Звіт за день', 'c:/report')],
  [btn('📜 Історія', 'c:/history'), btn('💵 Баланс', 'c:/balance')],
  [btn('🏦 Біржі і ключі', 'c:/exchanges'), btn('🪙 Монети', 'c:/coins')],
  [btn('⚙️ Налаштування', 'c:/settings'), btn('🔢 Кількість монет', 'c:/qty')],
  [btn('🛡 Захист', 'c:/safety'), btn('🔄 Звірка з біржами', 'c:/reconcile')],
  [btn('🧪 Самоперевірка', 'c:/selftest'), btn('📊 Статистика', 'c:/stats')],
  [btn('📈 Історія ставок', 'c:/backtest'), btn('📄 Експорт CSV', 'c:/export')],
  [btn('⏸ Пауза', 'c:/pause'), btn('▶️ Старт', 'c:/resume')],
  [btn('🛑 Закрити позицію', 'closemenu'), btn('❓ Усі команди', 'c:/help')],
]);

class Telegram {
  constructor({ token, chatIds, pin } = {}) {
    this.token = token;
    this.chatIds = (chatIds || []).map(String);
    this.enabled = Boolean(token && this.chatIds.length);
    this.offset = 0;
    this.stopped = false;
    this.awaiting = {}; // chatId -> { type, key?, ex? } — бот чекає на текст від користувача
    this.pin = String(pin || '');
    this.unlockedUntil = {}; // chatId -> ts: після правильного PIN 10 хв без повторного запиту
    this.pinFails = 0;
    this.pinLockedUntil = 0;
  }

  isUnlocked(chatId) {
    return !this.pin || (this.unlockedUntil[chatId] || 0) > Date.now();
  }

  /** Небезпечна дія: просимо PIN, після правильного — виконуємо відкладену дію. */
  async askPin(chatId, action) {
    if (Date.now() < this.pinLockedUntil) {
      return this.send(`🔒 Забагато невірних PIN. Спробуйте після ${new Date(this.pinLockedUntil).toISOString().slice(11, 16)} UTC.`, chatId);
    }
    this.awaiting[chatId] = { type: 'pin', action };
    return this.send('🔐 Ця дія потребує PIN. Надішліть PIN (повідомлення буде видалено).', chatId, inline([[btn('Скасувати', 'cancel')]]));
  }

  async checkPin(text, chatId, messageId, action) {
    if (messageId) this.api('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {});
    const a = Buffer.from(String(text).trim());
    const b = Buffer.from(this.pin);
    const ok = a.length === b.length && require('crypto').timingSafeEqual(a, b);
    if (!ok) {
      this.pinFails += 1;
      if (this.pinFails >= 5) {
        this.pinFails = 0;
        this.pinLockedUntil = Date.now() + 15 * 60000;
        log.warn('Telegram: 5 невірних PIN — блокування на 15 хв');
        return this.send('🚨 5 невірних PIN поспіль. Небезпечні дії заблоковано на 15 хв.', chatId);
      }
      return this.send(`❌ Невірний PIN (спроба ${this.pinFails}/5)`, chatId);
    }
    this.pinFails = 0;
    this.unlockedUntil[chatId] = Date.now() + 10 * 60000;
    await this.send('🔓 PIN прийнято (10 хв без повторного запиту)', chatId);
    return action();
  }

  async sendDocument(chatId, filename, content, caption) {
    log.info(`[tg] документ ${filename}`);
    if (!this.enabled) return;
    for (const id of chatId ? [String(chatId)] : this.chatIds) {
      try {
        const fd = new FormData();
        fd.append('chat_id', id);
        fd.append('document', new Blob([content], { type: 'text/csv' }), filename);
        if (caption) fd.append('caption', caption);
        const res = await fetch(`https://api.telegram.org/bot${this.token}/sendDocument`, { method: 'POST', body: fd });
        const json = await res.json();
        if (!json.ok) throw new Error(json.description);
      } catch (e) {
        log.warn(`Telegram sendDocument: ${e.message}`);
      }
    }
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

  /** @param {object} [markup] inline-клавіатура; без неї — постійні кнопки внизу */
  async send(text, chatId, markup) {
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
      for (let i = 0; i < chunks.length; i++) {
        const last = i === chunks.length - 1;
        try {
          await this.api('sendMessage', {
            chat_id: id,
            text: chunks[i],
            disable_web_page_preview: true,
            reply_markup: last && markup ? markup : KEYBOARD,
          });
        } catch (e) {
          log.warn(`Telegram send failed: ${e.message}`);
        }
      }
    }
  }

  async start(ctx) {
    if (!this.enabled) {
      log.warn('Telegram вимкнено: задайте TELEGRAM_BOT_TOKEN і TELEGRAM_CHAT_ID');
      return;
    }
    this.ctx = ctx;
    try {
      // Кнопка «Меню» ☰ біля поля вводу покаже всі команди з описами
      await this.api('setMyCommands', {
        commands: COMMANDS.flatMap(([, list]) => list).map(([command, description]) => ({ command, description: description.slice(0, 256) })),
      });
    } catch (e) {
      log.warn(`setMyCommands: ${e.message}`);
    }
    this.poll();
  }

  async poll() {
    while (!this.stopped) {
      try {
        const updates = await this.api('getUpdates', { offset: this.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
        for (const u of updates) {
          this.offset = u.update_id + 1;
          if (u.callback_query) {
            const cq = u.callback_query;
            const chatId = String(cq.message && cq.message.chat.id);
            this.api('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
            if (!this.chatIds.includes(chatId)) continue;
            this.handleCallback(cq.data, chatId).catch((e) => this.send(`❌ ${e.message}`, chatId));
            continue;
          }
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

  // ---------- Меню та кнопки ----------

  settingsMenu() {
    const { cfg } = this.ctx;
    const keys = Object.keys(SCHEMA);
    const rows = [];
    for (let i = 0; i < keys.length; i += 2) {
      rows.push(keys.slice(i, i + 2).map((k) => btn(`${SCHEMA[k].label}: ${display(SCHEMA[k], cfg[SCHEMA[k].field])}`, `set:${k}`)));
    }
    rows.push([btn('🔢 Кількість монет', 'c:/qty'), btn('🏠 Меню', 'm')]);
    return inline(rows);
  }

  async promptSetting(key, chatId) {
    const def = SCHEMA[key];
    const { cfg } = this.ctx;
    const cur = display(def, cfg[def.field]);
    const text = `⚙️ ${def.label}\n${def.desc}\n\nЗараз: ${cur}`;
    if (def.type === 'bool') {
      return this.send(text, chatId, inline([[btn('✅ Увімкнути (on)', `sv:${key}:on`), btn('❌ Вимкнути (off)', `sv:${key}:off`)], [btn('↩️ Назад', 'c:/settings')]]));
    }
    if (def.type === 'enum') {
      return this.send(text, chatId, inline([def.values.map((v) => btn(v, `sv:${key}:${v}`)), [btn('↩️ Назад', 'c:/settings')]]));
    }
    this.awaiting[chatId] = { type: 'set', key };
    const hint = { pct: 'у відсотках, напр. 0.5', num: 'число', int: 'ціле число', time: 'час HH:MM, напр. 23:55', list: 'монети через кому, напр. BTC,ETH (або - щоб очистити)' }[def.type];
    return this.send(`${text}\n\n✍️ Надішліть нове значення (${hint})`, chatId, inline([[btn('Скасувати', 'cancel')]]));
  }

  async exchangesMenu(chatId) {
    const { all, initErrors, keys, cfg } = this.ctx;
    const ids = SUPPORTED.concat(Object.keys(all).filter((id) => !META[id]));
    const lines = ids.map((id) => {
      const ex = all[id];
      const src = keys.source(id);
      const keyTxt = src ? `🔑 ${mask(keys.get(id).apiKey)} (${src})` : '— без ключа';
      if (!ex) return `⚪ ${META[id] ? META[id].title : id}: вимкнена (EXCHANGES)`;
      if (!ex.ready) return `🔴 ${ex.title}: не підключилась (${(initErrors[id] || '').slice(0, 80)}) ${keyTxt}`;
      return `🟢 ${ex.title}: ${ex.perpSymbols().length} монет, ${keyTxt}`;
    });
    const rows = [];
    const enabled = ids.filter((id) => all[id]);
    for (let i = 0; i < enabled.length; i += 2) {
      rows.push(enabled.slice(i, i + 2).map((id) => btn(`${keys.source(id) ? '🔑' : '➕'} ${all[id].title}`, `ex:${id}`)));
    }
    rows.push([btn('💵 Баланс', 'c:/balance'), btn('🏠 Меню', 'm')]);
    return this.send(
      `🏦 Біржі (${cfg.mode.toUpperCase()}):\n${lines.join('\n')}\n\n` +
        `Дані (ставки, стакани) беруться з усіх 🟢. ${cfg.mode === 'live' ? 'Торгівля — лише між біржами з 🔑.' : 'У PAPER ордери не ставляться.'}\n` +
        'Натисніть на біржу, щоб додати або змінити ключ.',
      chatId,
      inline(rows)
    );
  }

  async exchangeMenu(id, chatId) {
    const { all, keys } = this.ctx;
    const ex = all[id];
    if (!ex) return this.send('Біржа не увімкнена', chatId);
    const meta = META[id] || {};
    const src = keys.source(id);
    const rows = [[btn(src ? '🔄 Замінити ключ' : '➕ Додати ключ', `key:${id}`)]];
    if (src === 'telegram') rows.push([btn('🗑 Видалити ключ', `delkey:${id}`)]);
    rows.push([btn('↩️ Біржі', 'c:/exchanges')]);
    return this.send(
      `${ex.title}\nСтан: ${ex.ready ? '🟢 підключена' : '🔴 не підключена'}\nКлюч: ${src ? `${mask(keys.get(id).apiKey)} (${src})` : 'немає'}\n` +
        `Потрібно: API key + secret${meta.password ? ' + passphrase' : ''}\n${meta.keyHint || ''}\n⚠️ Ніколи не вмикайте право на виведення коштів.`,
      chatId,
      inline(rows)
    );
  }

  coinsMenu(chatId) {
    const { cfg } = this.ctx;
    return this.send(
      '🪙 Монети\n\nБот перевіряє, що монета з однаковою назвою на різних біржах — та сама:\n' +
        '1) адреса контракту в спільній мережі (ERC20/BEP20/SOL…) має збігатися;\n' +
        `2) ціни не мають відрізнятися більше ніж на ${R.pct(cfg.coinPriceTol, 1)};\n` +
        '3) ваші ручні рішення (заборонити / довіряти) мають пріоритет.\n' +
        `Режим «лише підтверджені адреси»: ${cfg.strictCoins ? 'on' : 'off'}\n\n` +
        '1000PEPE на одній біржі і PEPE на іншій зіставляються автоматично.',
      chatId,
      inline([
        [btn('🔍 Перевірити монету', 'coinask'), btn('⚠️ Конфлікти', 'c:/coinsbad')],
        [btn('🔢 Кількість для входу', 'c:/qty'), btn(`🔒 Лише підтверджені: ${cfg.strictCoins ? 'on' : 'off'}`, 'set:strictcoins')],
        [btn('🏠 Меню', 'm')],
      ])
    );
  }

  closeMenu(chatId) {
    const { state } = this.ctx;
    if (!state.positions.length) return this.send('Відкритих позицій немає', chatId, inline([[btn('🏠 Меню', 'm')]]));
    const rows = state.positions.map((p, i) => [btn(`❎ ${i + 1}. ${p.symbol.split('/')[0]} ${p.shortEx}/${p.longEx}`, `closeq:${i + 1}:${p.openedAt}`)]);
    rows.push([btn('🛑 Закрити ВСІ', 'closeallq'), btn('🏠 Меню', 'm')]);
    return this.send('Яку пару закрити?', chatId, inline(rows));
  }

  async handleCallback(data, chatId) {
    const [kind, a, b] = String(data).split(':');
    const { settings, state, trader } = this.ctx;
    const DANGER = ['sv', 'closey', 'closeally', 'orph', 'qtydel', 'coinok', 'coinreset', 'delkey', 'selftestfull'];
    if (DANGER.includes(kind) && !this.isUnlocked(chatId)) return this.askPin(chatId, () => this.handleCallback(data, chatId));
    if (kind !== 'set') delete this.awaiting[chatId];
    switch (kind) {
      case 'm':
        return this.send('🏠 Головне меню', chatId, MAIN_MENU);
      case 'c':
        return this.handle(data.slice(2), chatId);
      case 'cancel':
        delete this.awaiting[chatId];
        return this.send('Скасовано', chatId, MAIN_MENU);
      case 'set':
        return this.promptSetting(a, chatId);
      case 'sv': {
        const v = settings.set(a, b);
        return this.send(`✅ ${SCHEMA[a].label} = ${v}`, chatId, this.settingsMenu());
      }
      case 'ex':
        return this.exchangeMenu(a, chatId);
      case 'key': {
        const meta = META[a] || {};
        this.awaiting[chatId] = { type: 'setkey', ex: a };
        return this.send(
          `🔑 ${meta.title || a}: надішліть одним повідомленням через пробіл:\n` +
            `API_KEY SECRET${meta.password ? ' PASSPHRASE' : ''}\n\nПовідомлення буде одразу видалено з чату.`,
          chatId,
          inline([[btn('Скасувати', 'cancel')]])
        );
      }
      case 'delkey':
        return this.handle(`/delkey ${a}`, chatId);
      case 'coinask':
        this.awaiting[chatId] = { type: 'coin' };
        return this.send('🔍 Надішліть назву монети, напр. PEPE', chatId, inline([[btn('Скасувати', 'cancel')]]));
      case 'coinban':
        return this.handle(`/coinban ${a}${b ? ` ${b}` : ''}`, chatId);
      case 'coinok':
        return this.handle(`/coinok ${a}`, chatId);
      case 'coinreset':
        return this.handle(`/coinreset ${a}`, chatId);
      case 'qtyadd':
        this.awaiting[chatId] = { type: 'qty' };
        return this.send('✍️ Надішліть монету і кількість, напр.:\nBTC 0.01\n(можна кілька рядків; 0 — прибрати монету)', chatId, inline([[btn('Скасувати', 'cancel')]]));
      case 'qtydel':
        return this.handle(`/qty ${a} 0`, chatId);
      case 'closemenu':
        return this.closeMenu(chatId);
      case 'closeq': {
        const pos = state.positions[Number(a) - 1];
        if (!pos || String(pos.openedAt) !== b) return this.closeMenu(chatId);
        return this.send(`Закрити ${pos.symbol} ${pos.shortEx}/${pos.longEx} (${pos.base} шт)?`, chatId, inline([[btn('✅ Так, закрити', `closey:${a}:${b}`), btn('Ні', 'm')]]));
      }
      case 'closey': {
        const pos = state.positions[Number(a) - 1];
        if (!pos || String(pos.openedAt) !== b) return this.send('Позиція вже змінилась', chatId, MAIN_MENU);
        await this.send(`Закриваю ${pos.symbol}...`, chatId);
        await trader.withLock(() => trader.closePair(pos, 'закрито вручну через Telegram'));
        return undefined;
      }
      case 'closeallq':
        return this.send(`Закрити всі ${state.positions.length} пар?`, chatId, inline([[btn('✅ Так, закрити всі', 'closeally'), btn('Ні', 'm')]]));
      case 'closeally':
        return this.handle('/closeall yes', chatId);
      case 'selftestfull':
        return this.handle('/selftest full yes', chatId);
      case 'orph': {
        const r = await this.ctx.reconciler.closeOrphan(a);
        return this.send(r, chatId, MAIN_MENU);
      }
      default:
        return this.send('Невідома дія', chatId, MAIN_MENU);
    }
  }

  /** Користувач надіслав значення у відповідь на запит бота. */
  async handleInput(wait, text, chatId, messageId) {
    delete this.awaiting[chatId];
    if (wait.type === 'pin') return this.checkPin(text, chatId, messageId, wait.action);
    if (wait.type === 'setkey' && messageId) this.api('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {});
    if (['set', 'setkey', 'qty'].includes(wait.type) && !this.isUnlocked(chatId)) {
      return this.askPin(chatId, () => this.handleInput(wait, text, chatId));
    }
    switch (wait.type) {
      case 'set': {
        const v = this.ctx.settings.set(wait.key, text.replace(/\s+/g, ','));
        return this.send(`✅ ${SCHEMA[wait.key].label} = ${v}`, chatId, this.settingsMenu());
      }
      case 'setkey':
        return this.handle(`/setkey ${wait.ex} ${text}`, chatId, messageId);
      case 'coin':
        return this.handle(`/coin ${text}`, chatId);
      case 'qty': {
        for (const line of text.split('\n').filter((l) => l.trim())) await this.handle(`/qty ${line.trim()}`, chatId);
        return undefined;
      }
      default:
        return undefined;
    }
  }

  safetyText() {
    const { cfg, state, trader, all, guard } = this.ctx;
    const p = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
    const day = state.day();
    const s = state.data.stats;
    const errs = guard ? guard.errors.length : 0;
    const blocked = Object.values(all).filter((e) => e.tradeBlocked).map((e) => `${e.id}: ${e.tradeBlocked}`);
    const ioc = Object.values(all).filter((e) => e.iocUnsupported).map((e) => e.id);
    const stops = state.positions.flatMap((pos) => [['short', pos.shortEx], ['long', pos.longEx]].map(([k, ex]) => `${pos.symbol.split('/')[0]} ${ex} ${k}: ${pos[k].stopId ? `стоп ${R.fmt(pos[k].stopPrice, 8)}` : 'без стопу'}`));
    return (
      `🛡 Захист коштів (${cfg.mode.toUpperCase()}${cfg.sandbox ? ', ТЕСТОВІ МЕРЕЖІ' : ''})\n\n` +
      `Стан: ${cfg.paused ? `⏸ ПАУЗА${cfg.pauseReason ? ` — ${cfg.pauseReason}` : ''}` : '▶️ працює'}\n\n` +
      `Ордери: ${cfg.orderType === 'market' ? 'завжди ринкові' : 'бот обирає сам — лімітний IOC з межею ціни (слипедж ≤ ' + p(cfg.maxSlippagePct, 2) + '), ринковий для термінових закриттів'}` +
      `${ioc.length ? `\n   IOC не приймають: ${ioc.join(', ')} → ринкові` : ''}\n` +
      `Ліквідація: перевірка кожні ${cfg.liqCheckSec} с, бот закриває при ${p(cfg.liqClosePct)} шляху до ліквідації\n` +
      `Стопи на біржах: ${cfg.protectStops ? `on, на ${p(cfg.stopAtPct)} шляху до ліквідації` : 'off'}\n` +
      `${stops.length ? `${stops.map((x) => `   ${x}`).join('\n')}\n` : ''}` +
      `Звірка з біржами: кожні ${cfg.reconcileMin} хв\n\n` +
      `Запобіжники (автопауза):\n` +
      `   збиток за день: ${day.pnl.toFixed(2)} / ліміт ${cfg.maxDailyLossUsdt > 0 ? `−${cfg.maxDailyLossUsdt}` : 'вимк.'}\n` +
      `   збиткових поспіль: ${s.lossStreak || 0} / ${cfg.maxLossStreak || 'вимк.'}\n` +
      `   помилок за 10 хв: ${errs} / ${cfg.maxErrors || 'вимк.'}\n\n` +
      `Експозиція: зараз ${R.fmt(trader.openNotional(), 2)} ${cfg.quote}; ліміт загальний ${cfg.maxTotalUsdt || '—'}, на біржу ${cfg.maxExchangeUsdt || '—'}; резерв балансу ${p(cfg.reservePct)}\n` +
      `Фільтр монет: обсяг ≥ ${Number(cfg.minVolumeUsdt).toLocaleString('uk-UA')} USDT/24 год, лістинг > ${cfg.newListingDays} дн, делістинг > ${cfg.delistDays} дн, ціни ±${p(cfg.coinPriceTol, 1)}\n` +
      `Після виплати: чекати сходження цін до ${cfg.maxConvergeWaitMin} хв, якщо вихід зараз у мінус\n` +
      `Годинник: поправка ${(getClockOffset() / 1000).toFixed(2)} с\n` +
      `${blocked.length ? `⛔ Заблоковано: ${blocked.join('; ')}\n` : ''}` +
      `Незавершених намірів угод: ${(state.data.pending || []).length}`
    );
  }

  // ---------- Монети ----------

  coinReport(coinRaw) {
    const { all, coins } = this.ctx;
    const coin = String(coinRaw).toUpperCase().replace(/\/.*$/, '').replace(/^(1000000|1000|1M)(?=[A-Z])/, '');
    const symbol = `${coin}/USDT:USDT`;
    const rates = this.ctx.getRates();
    const tz = this.ctx.cfg.timezone;
    const listed = Object.values(all).filter((ex) => ex.ready && ex.native[symbol]);
    if (!listed.length) return { text: `Монету ${coin} не знайдено на жодній підключеній біржі`, coin };
    const lines = listed.map((ex) => {
      const r = rates[ex.id] && rates[ex.id][symbol];
      const mult = ex.mult[symbol] || 1;
      const nat = ex.marketBase ? ex.marketBase[symbol] : coin;
      const addrs = (coins && coins.addresses[ex.id] && coins.addresses[ex.id][coin]) || {};
      const addrTxt = Object.entries(addrs).map(([n, a]) => `${n} ${a.slice(0, 6)}…${a.slice(-4)}`).join(', ');
      return (
        `${coins && coins.isBanned(coin, ex.id) ? '🚫' : '•'} ${ex.title}: ${nat}${mult !== 1 ? ` (×${mult})` : ''}` +
        `${r ? `, ціна ${R.fmt(r.mark, 8)}, фандінг ${R.pct(r.rate, 4)}/${r.intervalH}h о ${r.nextTs ? clock(r.nextTs, tz) : '—'}` : ''}` +
        `\n   адреси: ${addrTxt || 'немає даних'}` +
        `${ex.tickers && ex.tickers[symbol] && ex.tickers[symbol].volumeUsdt ? `\n   обсяг 24 год: ${Math.round(ex.tickers[symbol].volumeUsdt).toLocaleString('uk-UA')} USDT` : ''}` +
        `${this.ctx.marketProblem && this.ctx.marketProblem(coin, ex.id) ? `\n   ⛔ ${this.ctx.marketProblem(coin, ex.id)}` : ''}`
      );
    });
    const checks = [];
    for (let i = 0; i < listed.length; i++) {
      for (let j = i + 1; j < listed.length; j++) {
        const A = listed[i];
        const B = listed[j];
        const mA = rates[A.id]?.[symbol]?.mark;
        const mB = rates[B.id]?.[symbol]?.mark;
        const c = coins ? coins.check(coin, A.id, B.id, mA, mB) : { ok: true, status: 'unknown' };
        const icon = !c.ok ? '❌' : c.status === 'confirmed' ? '✅' : c.status === 'trusted' ? '🤝' : '❓';
        const why = !c.ok ? c.reason : c.status === 'confirmed' ? 'адреса збігається' : c.status === 'trusted' ? 'довіряєте вручну' : 'адресу не перевірено, ціна в нормі';
        checks.push(`${icon} ${A.id} ↔ ${B.id}: ${why}`);
      }
    }
    return {
      coin,
      text: `🪙 ${coin}\n\n${lines.join('\n')}\n\nПеревірка пар:\n${checks.join('\n') || '—'}\n\n✅ та сама монета  ❓ не перевірено (торгується, якщо ціна в нормі)  ❌ різні монети — не торгується`,
    };
  }

  badCoins() {
    const { all, coins } = this.ctx;
    const rates = this.ctx.getRates();
    const bySymbol = {};
    for (const ex of Object.values(all)) {
      if (!ex.ready) continue;
      for (const [sym, r] of Object.entries(rates[ex.id] || {})) (bySymbol[sym] = bySymbol[sym] || []).push([ex.id, r]);
    }
    const bad = [];
    for (const [sym, list] of Object.entries(bySymbol)) {
      const coin = sym.split('/')[0];
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const c = coins.check(coin, list[i][0], list[j][0], list[i][1].mark, list[j][1].mark);
          if (!c.ok) bad.push(`❌ ${coin}: ${list[i][0]} ↔ ${list[j][0]} — ${c.reason}`);
        }
      }
    }
    return bad;
  }

  // ---------- Команди ----------

  async handle(text, chatId, messageId) {
    const reply = (t, markup) => this.send(t, chatId, markup);
    const { cfg, settings, state, trader } = this.ctx;

    // Відповідь на запит бота (значення налаштування, ключ, назва монети)
    const wait = this.awaiting[chatId];
    if (wait && !text.startsWith('/') && !BUTTONS[text]) return this.handleInput(wait, text, chatId, messageId);
    delete this.awaiting[chatId];

    const line = BUTTONS[text] || text;
    const [rawCmd, ...args] = line.split(/\s+/);
    const cmd = rawCmd.toLowerCase().replace(/@.*$/, '');

    // Небезпечні дії — лише після PIN (якщо TELEGRAM_PIN задано)
    const DANGER = ['/set', '/setkey', '/delkey', '/close', '/closeall', '/resume', '/coinok', '/coinreset', '/unblock'];
    const isDanger = (DANGER.includes(cmd) && !(cmd === '/close' && !args[0]) && !(cmd === '/closeall' && args[0] !== 'yes') && !(['/set', '/qty'].includes(cmd) && args.length < 2)) ||
      (cmd === '/qty' && args.length >= 2) || (cmd === '/selftest' && args[0] === 'full' && args[1] === 'yes');
    if (isDanger && !this.isUnlocked(chatId)) {
      if (cmd === '/setkey' && messageId) this.api('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => {});
      return this.askPin(chatId, () => this.handle(text, chatId));
    }

    switch (cmd) {
      case '/start':
      case '/menu':
        return reply('🏠 Головне меню. Натискайте кнопки — команди запам\'ятовувати не потрібно.', MAIN_MENU);
      case '/help':
        return reply(HELP, MAIN_MENU);
      case '/status':
        return reply(R.formatStatus(cfg, state, this.ctx.getRates(), this.ctx.getLastScanAt()), inline([[btn('📈 Позиції', 'c:/positions'), btn('🏠 Меню', 'm')]]));
      case '/positions':
        return reply(R.formatPositions(state, this.ctx.getRates(), cfg), state.positions.length ? inline([[btn('🛑 Закрити позицію', 'closemenu'), btn('🏠 Меню', 'm')]]) : undefined);
      case '/top': {
        // Для 5 найкращих — дивимось стакани: на яку суму реально можна зайти зараз
        const wins = this.ctx.getOpps().slice(0, 10);
        const caps = {};
        if (trader && trader.estimateCapacity) {
          await Promise.all(
            wins.slice(0, 5).map(async (w, i) => {
              try {
                const c = await trader.estimateCapacity(w);
                if (!c.error) caps[i] = c;
              } catch (e) {
                log.debug(`capacity ${w.symbol}: ${e.message}`);
              }
            })
          );
        }
        return reply(R.formatOpps(wins, cfg, 10, this.ctx.exchanges || {}, caps));
      }
      case '/report':
        return reply(R.formatDailyReport(cfg, state, state.dayKey(), this.ctx.getRates()));
      case '/history':
        return reply(R.formatHistory(state, Number(args[0]) || 10, cfg.quote));
      case '/settings':
        return reply('⚙️ Налаштування. Натисніть на параметр, щоб змінити:', this.settingsMenu());
      case '/set': {
        if (args.length < 2) return reply('Формат: /set <параметр> <значення>. Простіше — через кнопки:', this.settingsMenu());
        const key = args[0].toLowerCase();
        const v = settings.set(key, args.slice(1).join(','));
        let note = '';
        if (key === 'leverage') note = '\n(застосовується до нових позицій)';
        if (key === 'sizemode' && cfg.sizeMode === 'coins' && !Object.keys(cfg.coinQty).length) note = '\n⚠️ Задайте кількості: /qty BTC 0.01';
        return reply(`✅ ${key} = ${v}${note}`);
      }
      case '/qty': {
        if (args.length === 0) {
          const entries = Object.entries(cfg.coinQty);
          const rows = [];
          for (let i = 0; i < entries.length; i += 3) rows.push(entries.slice(i, i + 3).map(([c]) => btn(`🗑 ${c}`, `qtydel:${c}`)));
          rows.push([btn('➕ Додати / змінити', 'qtyadd'), btn('🏠 Меню', 'm')]);
          return reply(
            `🔢 Кількості монет для входу (режим: ${cfg.sizeMode}):\n${entries.length ? entries.map(([c, q]) => `${c}: ${q}`).join('\n') : '— не задано'}\n\n` +
              'У режимі coins бот торгує ЛИШЕ монети зі списку і входить/виходить рівно цією кількістю.',
            inline(rows)
          );
        }
        if (args.length < 2) return reply('Формат: /qty <монета> <кількість>');
        const c = settings.setQty(args[0], args[1]);
        return reply(cfg.coinQty[c] ? `✅ ${c}: вхід ${cfg.coinQty[c]} ${c}` : `✅ ${c} прибрано зі списку`);
      }
      case '/exchanges':
        return this.exchangesMenu(chatId);
      case '/balance': {
        const { exchanges } = this.ctx;
        const withKeys = Object.values(exchanges).filter((e) => e.hasKeys);
        if (!withKeys.length) return reply('Немає жодної біржі з API-ключем.', inline([[btn('🏦 Додати ключі', 'c:/exchanges')]]));
        const parts = await Promise.all(
          withKeys.map(async (ex) => {
            try {
              const [b, ps] = await Promise.all([ex.balanceSummary(), ex.openPositions().catch(() => [])]);
              const pos = ps.map((p) => `   ${p.canonical.split('/')[0]} ${p.side} ${p.contracts} контр. PnL ${+(p.unrealizedPnl || 0).toFixed(4)}`).join('\n');
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
        const { all, exchanges, keys, coins } = this.ctx;
        if (!all[id]) return reply(`Біржа "${args[0] || ''}" не увімкнена. Доступні: ${Object.keys(all).join(', ')}`);
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
          if (coins) coins.load(ex).catch(() => {}); // з ключем біржа може віддати адреси контрактів
          if (this.ctx.checkPositionMode) await this.ctx.checkPositionMode(ex);
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
      case '/coins':
        return this.coinsMenu(chatId);
      case '/coin': {
        if (!args[0]) {
          this.awaiting[chatId] = { type: 'coin' };
          return reply('🔍 Надішліть назву монети, напр. PEPE', inline([[btn('Скасувати', 'cancel')]]));
        }
        const { text: t, coin } = this.coinReport(args[0]);
        return reply(t, inline([
          [btn(`🚫 Заборонити ${coin}`, `coinban:${coin}`), btn(`🤝 Довіряти ${coin}`, `coinok:${coin}`)],
          [btn('↩️ Скинути рішення', `coinreset:${coin}`), btn('🏠 Меню', 'm')],
        ]));
      }
      case '/coinsbad': {
        const bad = this.badCoins();
        return reply(
          bad.length
            ? `⚠️ Монети з однаковою назвою, які бот вважає різними (не торгуються): ${bad.length}\n\n${bad.slice(0, 60).join('\n')}${bad.length > 60 ? '\n…' : ''}\n\nДеталі: /coin НАЗВА`
            : '✅ Конфліктів не знайдено',
          inline([[btn('🔍 Перевірити монету', 'coinask'), btn('🏠 Меню', 'm')]])
        );
      }
      case '/coinban': {
        if (!args[0]) return reply('Формат: /coinban <монета> [біржа] — без біржі забороняє на всіх');
        const coin = args[0].toUpperCase();
        const ex = args[1] ? normalizeName(args[1]) : '*';
        this.ctx.coins.ban(coin, ex);
        return reply(`🚫 ${coin} заборонено ${ex === '*' ? 'на всіх біржах' : `на ${ex}`}. Скасувати: /coinreset ${coin}`);
      }
      case '/coinok': {
        if (!args[0]) return reply('Формат: /coinok <монета>');
        const coin = args[0].toUpperCase();
        this.ctx.coins.trust(coin);
        return reply(`🤝 ${coin}: довіряєте — перевірки адреси і ціни для неї вимкнено. Скасувати: /coinreset ${coin}`);
      }
      case '/coinreset': {
        if (!args[0]) return reply('Формат: /coinreset <монета>');
        this.ctx.coins.reset(args[0].toUpperCase());
        return reply(`↩️ ${args[0].toUpperCase()}: ручні рішення скинуто, діють автоматичні перевірки`);
      }
      case '/selftest': {
        const full = args[0] === 'full';
        if (full && args[1] !== 'yes') {
          return reply(
            '🧪 Повна самоперевірка відкриє на КОЖНІЙ біржі з ключем мінімальну позицію (BTC або перша монета), поставить і зніме стоп, і одразу закриє позицію.\n' +
              'Коштує дві мінімальні комісії на біржу. Продовжити?',
            inline([[btn('✅ Так, повна перевірка', 'selftestfull'), btn('Ні', 'm')]])
          );
        }
        const exs = Object.values(this.ctx.exchanges).filter((e) => e.hasKeys);
        if (!exs.length) return reply('Немає бірж з API-ключами.', inline([[btn('🏦 Додати ключі', 'c:/exchanges')]]));
        await reply(`🧪 Самоперевірка${full ? ' (повна)' : ''}: ${exs.map((e) => e.id).join(', ')}…`);
        const out = await trader.withLock(() =>
          Promise.all(
            exs.map(async (ex) => {
              // монети, де бот має позицію на цій біржі, тест не чіпає
              const avoid = state.positions.filter((p) => p.shortEx === ex.id || p.longEx === ex.id).map((p) => p.symbol);
              return [ex, await ex.runSelfTest({ full, avoid })];
            })
          )
        );
        const lines = out.map(([ex, r]) => {
          if (this.ctx.applySelfTest) this.ctx.applySelfTest(ex, r);
          return `${r.ok ? '✅' : '⛔'} ${ex.title}\n${r.checks.map((c) => `   ${c.ok ? '✓' : c.critical === false ? '⚠' : '✗'} ${c.name}: ${c.info}`).join('\n')}`;
        });
        return reply(
          `${lines.join('\n\n')}\n\n✓ ok  ⚠ не критично (бот обійде)  ✗ критично — на цій біржі бот не торгує` +
            (full ? '' : '\n\nСтоп-ордери перевіряються лише в повній перевірці: /selftest full'),
          full ? undefined : inline([[btn('🧪 Повна перевірка (мін. угода)', 'c:/selftest full')], [btn('🏠 Меню', 'm')]])
        );
      }
      case '/unblock': {
        const id = normalizeName(args[0]);
        const ex = this.ctx.all[id];
        if (!ex) return reply(`Формат: /unblock <біржа>. Заблоковані: ${Object.values(this.ctx.all).filter((e) => e.tradeBlocked).map((e) => e.id).join(', ') || 'немає'}`);
        const was = ex.tradeBlocked;
        ex.tradeBlocked = undefined;
        if (state.data.fundingCheck) delete state.data.fundingCheck[id];
        state.save();
        return reply(`✅ ${ex.title}: блокування знято${was ? ` (було: ${was})` : ''}. Режим позицій і самоперевірка повторяться при наступному старті.`);
      }
      case '/stats':
        return reply(R.formatStats(state, cfg));
      case '/export': {
        const days = Number(args[0]) || 30;
        const csv = R.tradesCsv(state, days);
        const n = csv.trim().split('\n').length - 1;
        if (n <= 0) return reply(`За ${days} дн закритих угод немає`);
        await this.sendDocument(chatId, `trades_${state.dayKey()}_${days}d.csv`, csv, `Угоди за ${days} дн: ${n}`);
        return undefined;
      }
      case '/backtest': {
        const days = Math.min(Number(args[0]) || 7, 60);
        if (!this.ctx.runBacktest) return reply('Недоступно');
        if (this.backtestRunning) return reply('Перевірка вже виконується…');
        this.backtestRunning = true;
        await reply(`📈 Перевірка на історії за ${days} дн запущена — це займе кілька хвилин. Торгівля не зупиняється.`);
        this.ctx
          .runBacktest(days)
          .then((r) => this.send(r.text, chatId))
          .catch((e) => this.send(`❌ Перевірка на історії: ${e.message}`, chatId))
          .finally(() => {
            this.backtestRunning = false;
          });
        return undefined;
      }
      case '/pause':
        settings.setPaused(true);
        return reply('⏸ Пауза: нові позиції не відкриваються. Відкриті супроводжуються і закриваються за правилами.');
      case '/resume': {
        const was = cfg.pauseReason;
        if (this.ctx.guard) this.ctx.guard.resume();
        cfg.pauseReason = undefined;
        settings.setPaused(false);
        return reply(`▶️ Входи відновлено${was ? ` (автопауза була: ${was})` : ''}`);
      }
      case '/reconcile': {
        if (cfg.mode !== 'live') return reply('Звірка потрібна лише в LIVE-режимі (у PAPER реальних позицій немає).');
        const r = await trader.withLock(() => this.ctx.reconciler.run());
        const lines = [];
        if (r.autoClosed.length) lines.push(`Закрито непарних ніг після збою: ${r.autoClosed.length}`);
        if (r.orphans.length) lines.push(`Позицій на біржах, яких немає в боті: ${r.orphans.length} (див. повідомлення вище)`);
        if (r.mismatches.length) lines.push(`Розбіжностей: ${r.mismatches.length}`);
        if (r.failed && r.failed.length) lines.push(`Не відповіли: ${r.failed.join(', ')}`);
        return reply(`🔄 Звірка з біржами
${lines.length ? lines.join('\n') : '✅ Позиції бота збігаються з біржами'}`);
      }
      case '/safety':
        return reply(this.safetyText(), inline([[btn('🔄 Звірити зараз', 'c:/reconcile'), btn('⚙️ Налаштування', 'c:/settings')], [btn('🏠 Меню', 'm')]]));
      case '/close': {
        if (!args[0]) return this.closeMenu(chatId);
        const pos = state.positions[Number(args[0]) - 1];
        if (!pos) return reply('Немає такої позиції. Номери: /positions');
        await reply(`Закриваю ${pos.symbol} ${pos.shortEx}/${pos.longEx}...`);
        await trader.withLock(() => trader.closePair(pos, 'закрито вручну через Telegram'));
        return undefined;
      }
      case '/closeall': {
        if (!state.positions.length) return reply('Відкритих позицій немає');
        if (args[0] !== 'yes') return reply(`Закрити всі ${state.positions.length} пар?`, inline([[btn('✅ Так, закрити всі', 'closeally'), btn('Ні', 'm')]]));
        await trader.withLock(async () => {
          for (const pos of [...state.positions]) await trader.closePair(pos, 'закрито вручну (closeall)');
        });
        return undefined;
      }
      default:
        return reply('Не зрозумів. Ось меню 👇', MAIN_MENU);
    }
  }
}

module.exports = { Telegram, COMMANDS, HELP };
