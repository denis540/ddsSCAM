'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeName } = require('./exchanges-meta');

/**
 * Сховище API-ключів: .env (BINANCE_API_KEY ...) + ключі, додані через Telegram (data/keys.json, права 600).
 * Ключі з Telegram мають пріоритет.
 */
class KeyStore {
  constructor(envCredentials, file) {
    this.env = envCredentials || {};
    this.file = file;
    this.saved = {};
    if (file && fs.existsSync(file)) {
      try {
        this.saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        this.saved = {};
      }
    }
  }

  get(name) {
    const id = normalizeName(name);
    const s = this.saved[id];
    if (s && s.apiKey) return s;
    const e = this.env[id];
    return e && e.apiKey ? e : {};
  }

  source(name) {
    const id = normalizeName(name);
    if (this.saved[id] && this.saved[id].apiKey) return 'telegram';
    if (this.env[id] && this.env[id].apiKey) return '.env';
    return undefined;
  }

  set(name, creds) {
    this.saved[normalizeName(name)] = { apiKey: creds.apiKey, secret: creds.secret, password: creds.password };
    this.save();
  }

  remove(name) {
    delete this.saved[normalizeName(name)];
    this.save();
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.saved, null, 2), { mode: 0o600 });
    fs.chmodSync(this.file, 0o600);
  }
}

/** Маскування ключа для показу: abcd…wxyz */
const mask = (k) => (k ? `${k.slice(0, 4)}…${k.slice(-4)}` : '—');

module.exports = { KeyStore, mask };
