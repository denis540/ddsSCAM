import { log, errMsg } from './logger.js';

export class Notifier {
  constructor(private token?: string, private chatId?: string) {}

  /** Fire-and-forget: never blocks the trading path. */
  send(text: string): void {
    if (!this.token || !this.chatId) return;
    fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(5000),
    }).catch((e) => log.warn('telegram send failed', { err: errMsg(e) }));
  }
}
