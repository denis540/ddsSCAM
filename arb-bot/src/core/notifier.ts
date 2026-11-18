import { log, errMsg } from './logger.js';

type Handler = (args: string[]) => Promise<string> | string;

/**
 * Telegram alerts + remote control. Only messages from TELEGRAM_CHAT_ID are
 * obeyed. Commands: /status /cycles /pnl /pause /resume /help
 */
export class Notifier {
  private handlers = new Map<string, Handler>();
  private offset = 0;
  private polling = false;

  constructor(private token?: string, private chatId?: string) {}

  get enabled() {
    return !!this.token && !!this.chatId;
  }

  /** Fire-and-forget: never blocks the trading path. */
  send(text: string): void {
    if (!this.enabled) return;
    this.api('sendMessage', { chat_id: this.chatId, text: text.slice(0, 4000), disable_web_page_preview: true }).catch((e) =>
      log.warn('telegram send failed', { err: errMsg(e) }),
    );
  }

  command(name: string, h: Handler) {
    this.handlers.set(name, h);
  }

  startPolling() {
    if (!this.enabled || this.polling) return;
    this.polling = true;
    void (async () => {
      while (this.polling) {
        try {
          const r = await this.api('getUpdates', { offset: this.offset, timeout: 25 }, 35_000);
          for (const u of r.result ?? []) {
            this.offset = u.update_id + 1;
            const m = u.message;
            if (!m?.text || String(m.chat?.id) !== String(this.chatId)) continue;
            const [cmd, ...args] = m.text.trim().split(/\s+/);
            const h = this.handlers.get(cmd.replace(/@.*$/, '').toLowerCase());
            const reply = h ? await Promise.resolve(h(args)).catch((e) => `error: ${errMsg(e)}`) : `unknown command. ${[...this.handlers.keys()].join(' ')}`;
            this.send(reply);
          }
        } catch (e) {
          log.debug('telegram poll error', { err: errMsg(e) });
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    })();
  }

  stop() {
    this.polling = false;
  }

  private async api(method: string, body: unknown, timeoutMs = 8000): Promise<any> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.json();
  }
}
