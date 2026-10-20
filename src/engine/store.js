'use strict';

/** Small JSON store for settings, history and the last scan (atomic writes). */

const fsp = require('fs/promises');
const path = require('path');

const config = require('./config');

const MAX_HISTORY = 100;

async function readJson(file, fallback) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

/** Written to a temporary file first so a half-written file is never left behind. */
async function writeJson(file, data) {
  const dir = path.dirname(file);
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

// ------------------------------------------------------------------ secrets
/**
 * Electron's `safeStorage` bridge keeps the API key out of plain text on disk.
 * The main process binds it through `setSecretCipher`; when it is not bound
 * (tests, command line) the value is written in plain text, but values with
 * the `enc:` prefix are still decrypted.
 */
const SECRET_PREFIX = 'enc:';
let secretCipher = null;

function setSecretCipher(cipher) {
  secretCipher = cipher && typeof cipher.encrypt === 'function' ? cipher : null;
}

function encodeSecret(plain) {
  const value = String(plain || '').trim();
  if (!value) return '';
  if (!secretCipher) return value;
  try {
    return SECRET_PREFIX + secretCipher.encrypt(value);
  } catch {
    return value;
  }
}

function decodeSecret(stored) {
  const value = typeof stored === 'string' ? stored : '';
  if (!value) return '';
  if (!value.startsWith(SECRET_PREFIX)) return value;
  if (!secretCipher) return '';
  try {
    return secretCipher.decrypt(value.slice(SECRET_PREFIX.length));
  } catch {
    return '';
  }
}

/** Produces a hint such as `sk-…9f2a`; the key itself never reaches the interface. */
function secretHint(secret) {
  const value = String(secret || '');
  if (!value) return '';
  if (value.length <= 10) return '•'.repeat(value.length);
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}

// ------------------------------------------------------------------ AI settings
const TEXT_LIMIT = 300;

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

/** The endpoint must be http(s); trailing slashes are trimmed. */
function normalizeBaseUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (!/^https?:\/\//i.test(text)) return '';
  return text.replace(/\/+$/, '').slice(0, TEXT_LIMIT);
}

function normalizeAiFields(settings) {
  const next = { ...settings };
  next.ai_provider = config.AI_PROVIDERS.includes(next.ai_provider) ? next.ai_provider : 'auto';
  next.ai_openai_base = normalizeBaseUrl(next.ai_openai_base);
  next.ai_openai_model = String(next.ai_openai_model || '').trim().slice(0, TEXT_LIMIT);
  next.ai_temperature = clampNumber(next.ai_temperature, 0, 2, 0.3);
  next.ai_max_tokens = Math.round(clampNumber(next.ai_max_tokens, 64, 4096, 320));
  return next;
}

async function readSettingsFile() {
  const stored = await readJson(config.SETTINGS_FILE, {});
  return stored && typeof stored === 'object' ? stored : {};
}

/** Settings (key in plain text). Used only in the main process. */
async function getSettings() {
  const stored = await readSettingsFile();
  // Profiles written before the language choice was tracked carry a language
  // nobody picked explicitly (the old default was the Windows language). Such a
  // profile is read as the new default, so existing installations open in
  // English; picking a language in Settings marks the choice and is kept.
  if (!stored.language_explicit) stored.language = config.DEFAULT_SETTINGS.language;
  const merged = normalizeAiFields({ ...config.DEFAULT_SETTINGS, ...stored });
  if (merged.clean_mode !== 'delete') merged.clean_mode = 'quarantine';
  merged.ai_openai_key = decodeSecret(stored.ai_openai_key);
  return merged;
}

/**
 * Safe copy returned to the interface: the key is cleared and replaced by
 * whether it is set plus a non-reversible hint.
 */
async function getPublicSettings() {
  const settings = await getSettings();
  const key = settings.ai_openai_key;
  return {
    ...settings,
    ai_openai_key: '',
    ai_openai_key_set: Boolean(key),
    ai_openai_key_hint: secretHint(key),
    ai_openai_base_effective: settings.ai_openai_base || config.OPENAI_BASE || config.OPENAI_DEFAULT_BASE,
    ai_openai_model_effective:
      settings.ai_openai_model || config.OPENAI_MODEL || config.OPENAI_DEFAULT_MODEL,
    ai_providers: config.AI_PROVIDERS,
  };
}

async function saveSettings(patch) {
  const stored = await readSettingsFile();
  const incoming = { ...(patch || {}) };

  // The key is special-cased: omitting the field keeps the current value,
  // sending it empty clears it.
  let encodedKey = typeof stored.ai_openai_key === 'string' ? stored.ai_openai_key : '';
  if (Object.prototype.hasOwnProperty.call(incoming, 'ai_openai_key')) {
    const plain = String(incoming.ai_openai_key || '').trim();
    delete incoming.ai_openai_key;
    encodedKey = plain ? encodeSecret(plain) : '';
  }

  const next = normalizeAiFields({ ...config.DEFAULT_SETTINGS, ...stored, ...incoming });
  if (next.clean_mode !== 'delete') next.clean_mode = 'quarantine';
  next.deep_scan = Boolean(next.deep_scan);
  next.auto_select_safe = Boolean(next.auto_select_safe);
  next.reduce_motion = Boolean(next.reduce_motion);
  next.ai_openai_key = encodedKey;
  if (Object.prototype.hasOwnProperty.call(incoming, 'language')) next.language_explicit = true;

  await writeJson(config.SETTINGS_FILE, next);
  return getPublicSettings();
}

/**
 * Effective OpenAI configuration for ai.js. Precedence: settings file →
 * environment variable → built-in default.
 */
async function getAiConfig() {
  const settings = await getSettings();
  const base = settings.ai_openai_base || config.OPENAI_BASE || config.OPENAI_DEFAULT_BASE;
  const model = settings.ai_openai_model || config.OPENAI_MODEL || config.OPENAI_DEFAULT_MODEL;
  const key = settings.ai_openai_key || config.OPENAI_KEY || '';
  return {
    provider: settings.ai_provider || 'auto',
    base: String(base).replace(/\/+$/, ''),
    model,
    key,
    has_key: Boolean(key),
    key_source: settings.ai_openai_key ? 'settings' : config.OPENAI_KEY ? 'env' : '',
    base_source: settings.ai_openai_base
      ? 'settings'
      : config.OPENAI_BASE
        ? 'env'
        : 'default',
    model_source: settings.ai_openai_model
      ? 'settings'
      : config.OPENAI_MODEL
        ? 'env'
        : 'default',
    temperature: Number(settings.ai_temperature) || 0.3,
    max_tokens: Number(settings.ai_max_tokens) || 320,
  };
}

// ------------------------------------------------------------------ history
async function getHistory() {
  const rows = await readJson(config.HISTORY_FILE, []);
  return Array.isArray(rows) ? rows : [];
}

async function appendHistory(entry) {
  const rows = await getHistory();
  rows.unshift(entry);
  await writeJson(config.HISTORY_FILE, rows.slice(0, MAX_HISTORY));
  return rows.slice(0, MAX_HISTORY);
}

async function clearHistory() {
  await writeJson(config.HISTORY_FILE, []);
  return [];
}

// ------------------------------------------------------------------ last scan
async function saveLastScan(view) {
  await writeJson(config.LAST_SCAN_FILE, view);
  return view;
}

async function getLastScan() {
  return readJson(config.LAST_SCAN_FILE, null);
}

module.exports = {
  readJson,
  writeJson,
  setSecretCipher,
  encodeSecret,
  decodeSecret,
  secretHint,
  getSettings,
  getPublicSettings,
  saveSettings,
  getAiConfig,
  getHistory,
  appendHistory,
  clearHistory,
  saveLastScan,
  getLastScan,
};
