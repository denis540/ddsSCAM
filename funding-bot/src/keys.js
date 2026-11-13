'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeName } = require('./exchanges-meta');

/** AES-256-GCM: ключ виводиться з пароля через scrypt; зіпсований файл або неправильний пароль → помилка. */
function encrypt(obj, secret) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(secret, salt, 32);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { enc: 'aes-256-gcm', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function decrypt(box, secret) {
  if (!secret) throw new Error('data/keys.json зашифровано — задайте KEYS_SECRET');
  try {
    const key = crypto.scryptSync(secret, Buffer.from(box.salt, 'base64'), 32);
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
    d.setAuthTag(Buffer.from(box.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8'));
  } catch {
    throw new Error('не вдалося розшифрувати data/keys.json — неправильний KEYS_SECRET');
  }
}

/**
 * Сховище API-ключів: .env (BINANCE_API_KEY ...) + ключі, додані через Telegram (data/keys.json, права 600).
 * Ключі з Telegram мають пріоритет.
 */
class KeyStore {
  /**
   * @param {string} [secret] KEYS_SECRET — якщо задано, файл шифрується (AES-256-GCM).
   *        Незашифрований файл автоматично перешифровується при старті.
   */
  constructor(envCredentials, file, secret = '') {
    this.env = envCredentials || {};
    this.file = file;
    this.secret = secret;
    this.saved = {};
    if (file && fs.existsSync(file)) {
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        raw = {};
      }
      if (raw && raw.enc) {
        this.saved = decrypt(raw, secret);
      } else {
        this.saved = raw || {};
        if (secret && Object.keys(this.saved).length) this.save(); // міграція у зашифрований вигляд
      }
    }
  }

  get encrypted() {
    return Boolean(this.secret);
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
    const body = this.secret ? encrypt(this.saved, this.secret) : this.saved;
    fs.writeFileSync(this.file, JSON.stringify(body, null, 2), { mode: 0o600 });
    fs.chmodSync(this.file, 0o600);
  }
}

/** Маскування ключа для показу: abcd…wxyz */
const mask = (k) => (k ? `${k.slice(0, 4)}…${k.slice(-4)}` : '—');

module.exports = { KeyStore, mask };
