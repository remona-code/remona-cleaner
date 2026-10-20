'use strict';

/**
 * Çok dilli metin katmanı.
 *
 * Tek doğruluk kaynağı `locales/en.json` dosyasıdır: bütün anahtarlar önce
 * İngilizce yazılır, diğer diller onun üzerine yama gibi biner. Bir dilde
 * anahtar eksikse sırayla şu denenir:
 *
 *   1. seçili dilin kataloğu
 *   2. İngilizce katalog
 *   3. anahtarın kendisi
 *
 * Bu yüzden yarım çevrilmiş bir dil bile uygulamayı bozmaz; yalnızca eksik
 * satırlar İngilizce görünür. Desteklenmeyen bir Windows dili seçilirse
 * (ör. Fince) arayüz tamamen İngilizce açılır.
 *
 * Katman hem ana süreçte (motor metinleri) hem de arayüzde kullanılır;
 * arayüz kataloğu IPC ile tek seferde alır ve kendi `t()` işlevini kurar.
 */

const fs = require('fs');
const path = require('path');

const LOCALES_DIR = path.join(__dirname, 'locales');
const BASE_LOCALE = 'en';

/**
 * Arayüzde listelenen diller: kod, kendi dilindeki adı, İngilizce adı, sağdan
 * sola mı. Kataloğu (`locales/<kod>.json`) bulunmayan diller burada dursa bile
 * listeye girmez; böylece yarım bir dil kullanıcıya sunulmaz.
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

// ------------------------------------------------------------------ katalog
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

/** Kataloğu okur ve düz anahtar sözlüğüne çevirir (bir kez, sonra önbellek). */
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
/** Kataloğu olan diller (listeleme sırası korunur). */
function availableLocales() {
  return LOCALE_META.filter((meta) => hasCatalog(meta.code));
}

function localeMeta(code) {
  // Yön ve yerel ad bilgisi kataloğa bağlı değildir: Arapça kataloğu henüz
  // yoksa bile dil sağdan sola yazılır. Bu yüzden önce istenen kod aranır,
  // bulunamazsa çözümlenmiş dile düşülür.
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
 * 'tr-TR' -> 'tr', 'zh-CN' -> 'zh', 'auto' -> İngilizce, tanınmayan -> 'en'.
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

  // Bölgesel varyantın ana dili varsa onu kullan (ör. 'pt-br' -> 'pt').
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

// ------------------------------------------------------------------ çeviri
/**
 * Anahtarı çevirir. `{ad}` yer tutucuları `vars` ile doldurulur.
 * Eksik anahtar zinciri: seçili dil -> İngilizce -> anahtarın kendisi.
 */
function t(key, vars) {
  const name = String(key || '');
  if (!name) return '';

  let text = loadCatalog(currentLocale)[name];
  if (text === undefined) text = loadCatalog(BASE_LOCALE)[name];
  if (text === undefined) return name;

  return interpolate(String(text), vars);
}

/** Belirli bir dilde çeviri (kataloğu değiştirmeden). */
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
 * Arayüze gönderilen paket: İngilizce katalog üzerine seçili dil bindirilir.
 * Böylece arayüz tek bir `t()` ile çalışır ve eksik anahtar kendiliğinden
 * İngilizce görünür.
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

// ------------------------------------------------------------------ biçim
/** Dile duyarlı tam sayı: en 1,234,567 · tr 1.234.567 */
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

/** Sistem dilini (ör. 'de-DE') uygulamanın desteklediği koda çevirir. */
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
