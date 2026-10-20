'use strict';

/**
 * Multilingual text layer.
 *
 * The single source of truth is `locales/en.json`: every key is written in
 * English first and other languages layer on top like a patch. When a key is
 * missing in a language, the following are tried in order:
 *
 *   1. the catalogue of the selected language
 *   2. the English catalogue
 *   3. the key itself
 *
 * A half-translated language therefore never breaks the app; only the missing
 * lines appear in English. If an unsupported Windows language is selected
 * (Finnish, for example) the interface opens fully in English.
 *
 * The layer is used both in the main process (engine text) and in the
 * interface; the interface fetches the catalogue once over IPC and builds its own `t()`.
 */

const fs = require('fs');
const path = require('path');

const LOCALES_DIR = path.join(__dirname, 'locales');
const BASE_LOCALE = 'en';

/**
 * Languages listed in the interface: code, native name, English name and
 * whether it is right-to-left. A language without a catalogue
 * (`locales/<code>.json`) is not offered even when defined here, so a half-finished language never reaches users.
 */
const LOCALE_META = [
  { code: 'en', native: 'English', english: 'English', rtl: false },
  { code: 'tr', native: 'Türkçe', english: 'Turkish', rtl: false },
  { code: 'de', native: 'Deutsch', english: 'German', rtl: false },
  { code: 'fr', native: 'Français', english: 'French', rtl: false },
  { code: 'es', native: 'Español', english: 'Spanish', rtl: false },
  { code: 'it', native: 'Italiano', english: 'Italian', rtl: false },
  { code: 'pt', native: 'Português', english: 'Portuguese', rtl: false },
  { code: 'ru', native: 'Русский', english: 'Russian', rtl: false },
  { code: 'uk', native: 'Українська', english: 'Ukrainian', rtl: false },
  { code: 'pl', native: 'Polski', english: 'Polish', rtl: false },
  { code: 'nl', native: 'Nederlands', english: 'Dutch', rtl: false },
  { code: 'zh', native: '简体中文', english: 'Chinese (Simplified)', rtl: false },
  { code: 'ja', native: '日本語', english: 'Japanese', rtl: false },
  { code: 'ko', native: '한국어', english: 'Korean', rtl: false },
  { code: 'ar', native: 'العربية', english: 'Arabic', rtl: true },
  { code: 'fa', native: 'فارسی', english: 'Persian', rtl: true },
  { code: 'hi', native: 'हिन्दी', english: 'Hindi', rtl: false },
  { code: 'id', native: 'Bahasa Indonesia', english: 'Indonesian', rtl: false },
  { code: 'vi', native: 'Tiếng Việt', english: 'Vietnamese', rtl: false },
  { code: 'el', native: 'Ελληνικά', english: 'Greek', rtl: false },
];

const catalogCache = new Map();
let currentLocale = BASE_LOCALE;

// ------------------------------------------------------------------ catalogue
function catalogPath(code) {
  return path.join(LOCALES_DIR, `${code}.json`);
}

function hasCatalog(code) {
  try {
    return fs.statSync(catalogPath(code)).isFile();
  } catch {
    return false;
  }
}

/** Reads the catalogue into a flat key dictionary (once, then cached). */
function loadCatalog(code) {
  if (catalogCache.has(code)) return catalogCache.get(code);

  let flat = {};
  try {
    const raw = fs.readFileSync(catalogPath(code), 'utf8');
    flat = flatten(JSON.parse(raw));
  } catch {
    flat = {};
  }
  catalogCache.set(code, flat);
  return flat;
}

/** { nav: { home: 'x' } } -> { 'nav.home': 'x' } */
function flatten(source, prefix = '', out = {}) {
  if (!source || typeof source !== 'object') return out;
  for (const [key, value] of Object.entries(source)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, full, out);
    else out[full] = value;
  }
  return out;
}

// ------------------------------------------------------------------ dil
/** Languages that have a catalogue (listing order is preserved). */
function availableLocales() {
  return LOCALE_META.filter((meta) => hasCatalog(meta.code));
}

function localeMeta(code) {
  // Direction and native name do not depend on the catalogue: Arabic is right-
  // to-left even without a catalogue yet. The requested code is looked up first,
  // falling back to the resolved language.
  const raw = String(code === undefined ? currentLocale : code || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  const short = raw.split('-')[0];
  const direct =
    LOCALE_META.find((meta) => meta.code === raw) ||
    LOCALE_META.find((meta) => meta.code === short);
  if (direct) return direct;

  const resolved = resolveLocale(code);
  return LOCALE_META.find((meta) => meta.code === resolved) || LOCALE_META[0];
}

/**
 * Herhangi bir dil etiketini desteklenen bir koda indirger.
 * 'tr-TR' -> 'tr', 'zh-CN' -> 'zh', 'auto' -> English, anything unknown -> 'en'.
 */
function resolveLocale(input) {
  const raw = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');

  if (!raw || raw === 'auto' || raw === 'system' || raw === 'default') return BASE_LOCALE;
  if (hasCatalog(raw)) return raw;

  const short = raw.split('-')[0];
  if (hasCatalog(short)) return short;

  // Use the base language of a regional variant when available ('pt-br' -> 'pt').
  const regional = availableLocales().find((meta) => meta.code.split('-')[0] === short);
  return regional ? regional.code : BASE_LOCALE;
}

function setLocale(input) {
  currentLocale = resolveLocale(input);
  return currentLocale;
}

function getLocale() {
  return currentLocale;
}

function isRtl(code = currentLocale) {
  return Boolean(localeMeta(code).rtl);
}

// ------------------------------------------------------------------ translation
/**
 * Translates a key. `{name}` placeholders are filled from `vars`.
 * Missing-key chain: selected language -> English -> the key itself.
 */
function t(key, vars) {
  const name = String(key || '');
  if (!name) return '';

  let text = loadCatalog(currentLocale)[name];
  if (text === undefined) text = loadCatalog(BASE_LOCALE)[name];
  if (text === undefined) return name;

  return interpolate(String(text), vars);
}

/** Translation for a specific language (does not change the catalogue). */
function tIn(locale, key, vars) {
  const code = resolveLocale(locale);
  const name = String(key || '');
  let text = loadCatalog(code)[name];
  if (text === undefined) text = loadCatalog(BASE_LOCALE)[name];
  if (text === undefined) return name;
  return interpolate(String(text), vars);
}

function interpolate(text, vars) {
  if (!vars || typeof vars !== 'object') return text;
  return text.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
  );
}

function has(key) {
  const name = String(key || '');
  return (
    Object.prototype.hasOwnProperty.call(loadCatalog(currentLocale), name) ||
    Object.prototype.hasOwnProperty.call(loadCatalog(BASE_LOCALE), name)
  );
}

/**
 * Bundle sent to the interface: the selected language is layered over English.
 * The interface therefore works with a single `t()` and a missing key falls
 * back to English on its own.
 */
function bundle(locale = currentLocale) {
  const code = resolveLocale(locale);
  return {
    locale: code,
    rtl: isRtl(code),
    fallback: BASE_LOCALE,
    dict: { ...loadCatalog(BASE_LOCALE), ...loadCatalog(code) },
  };
}

// ------------------------------------------------------------------ format
/** Language-aware integer: en 1,234,567 · tr 1.234.567 */
function number(value, locale = currentLocale) {
  const n = Number(value) || 0;
  try {
    return new Intl.NumberFormat(locale).format(Math.round(n));
  } catch {
    return String(Math.round(n));
  }
}

/** 1536 -> '1.5 KB' (en) · '1,5 KB' (tr) */
function humanSize(bytes, locale = currentLocale) {
  let n = Number(bytes) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i];
    if (Math.abs(n) < 1024 || unit === 'TB') {
      if (unit === 'B') return `${Math.trunc(n)} ${unit}`;
      let text;
      try {
        text = new Intl.NumberFormat(locale, {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        }).format(n);
      } catch {
        text = n.toFixed(1);
      }
      return `${text} ${unit}`;
    }
    n /= 1024;
  }
  return `${n.toFixed(1)} TB`;
}

function formatDate(seconds, locale = currentLocale) {
  const value = Number(seconds);
  if (!value) return '-';
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) return '-';
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function formatDateTime(seconds, locale = currentLocale) {
  const value = Number(seconds);
  if (!value) return '-';
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) return '-';
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** Maps the system language ('de-DE', for example) to a code the app supports. */
function detectLocale(systemLocale) {
  return resolveLocale(systemLocale);
}

module.exports = {
  BASE_LOCALE,
  LOCALE_META,
  LOCALES_DIR,
  availableLocales,
  bundle,
  catalogPath,
  detectLocale,
  flatten,
  formatDate,
  formatDateTime,
  getLocale,
  has,
  hasCatalog,
  humanSize,
  interpolate,
  isRtl,
  loadCatalog,
  localeMeta,
  number,
  resolveLocale,
  setLocale,
  t,
  tIn,
};
