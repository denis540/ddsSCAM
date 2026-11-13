'use strict';

const log = require('./logger');
const R = require('./report');
const { META, normalizeName, SUPPORTED } = require('./exchanges-meta');
const { SCHEMA, display } = require('./settings');
const { mask } = require('./keys');
const { clock } = require('./time');

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
  [btn('⏸ Пауза', 'c:/pause'), btn('▶️ Старт', 'c:/resume')],
  [btn('🛑 Закрити позицію', 'closemenu'), btn('❓ Усі команди', 'c:/help')],
]);

class Telegram {
  constructor({ token, chatIds }) {
    this.token = token;
    this.chatIds = (chatIds || []).map(String);
    this.enabled = Boolean(token && this.chatIds.length);
    this.offset = 0;
    this.stopped = false;
    this.awaiting = {}; // chatId -> { type, key?, ex? } — бот чекає на текст від користувача
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
      default:
        return this.send('Невідома дія', chatId, MAIN_MENU);
    }
  }

  /** Користувач надіслав значення у відповідь на запит бота. */
  async handleInput(wait, text, chatId, messageId) {
    delete this.awaiting[chatId];
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
        `\n   адреси: ${addrTxt || 'немає даних'}`
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
      case '/pause':
        settings.setPaused(true);
        return reply('⏸ Пауза: нові позиції не відкриваються. Відкриті супроводжуються і закриваються за правилами.');
      case '/resume':
        settings.setPaused(false);
        return reply('▶️ Входи відновлено');
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
