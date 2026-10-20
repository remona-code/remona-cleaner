'use strict';

/**
 * Çeviri denetimi.
 *
 * Üç şeyi doğrular:
 *
 *   1. Kod ve HTML'in kullandığı bütün anahtarlar İngilizce katalogda var mı?
 *      Arayüz (data-i18n* öznitelikleri ve t('...') çağrıları), motor ve ana
 *      süreç (i18n.t('...') çağrıları) birlikte taranır. Eksik anahtar
 *      kullanıcıya ham `cat.foo.name` olarak görünür — bu yüzden hatadır.
 *   2. Her çeviri kataloğunda hangi anahtar eksik? Eksik anahtar İngilizce'ye
 *      düştüğü için bu hata değildir; kapsama oranı olarak raporlanır.
 *   3. Bir katalogda İngilizce'de olmayan (artık) anahtar var mı?
 *
 * Kullanım: node scripts/i18n-audit.js [--strict]
 *   --strict  yarım çevrilmiş bir dil varsa da başarısız say (CI için).
 */

const fs = require('fs');
const path = require('path');
const i18n = require('../src/i18n');

const ROOT = path.join(__dirname, '..');
const CODE_DIRS = ['src/renderer', 'src/engine', 'electron'];

/** data-i18n, data-i18n-title, data-i18n-ph, data-i18n-aria */
function keysFromHtml(file) {
  const text = fs.readFileSync(file, 'utf8');
  const keys = [];
  const pattern = /data-i18n(?:-title|-ph|-aria)?="([^"]+)"/g;
  let match;
  while ((match = pattern.exec(text)) !== null) keys.push(match[1]);
  return keys;
}

/** t('anahtar') ve t(`anahtar.${x}`) biçimleri; şablonlar sonra çözülür. */
function keysFromScript(file) {
  const text = fs.readFileSync(file, 'utf8');
  const keys = [];
  const literal = /\b(?:i18n\.)?t\(\s*'([^']+)'/g;
  const template = /\b(?:i18n\.)?t\(\s*`([^`]+)`/g;
  const inCatalog = /\b(?:has|hasCatalog)\(\s*'([^']+)'/g;
  let match;
  while ((match = literal.exec(text)) !== null) keys.push(match[1]);
  while ((match = template.exec(text)) !== null) keys.push(match[1]);
  while ((match = inCatalog.exec(text)) !== null) keys.push(match[1]);
  return keys;
}

/** `view.${view}.title` gibi şablonları katalogdaki somut anahtarlarla eşler. */
function expandTemplate(key, catalogKeys) {
  if (!key.includes('${')) return [key];
  const escaped = key
    .split(/\$\{[^}]+\}/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^.]+');
  const pattern = new RegExp(`^${escaped}$`);
  const matches = catalogKeys.filter((candidate) => pattern.test(candidate));
  return matches.length ? matches : [key];
}

function collectUsedKeys() {
  const used = new Set();
  for (const dir of CODE_DIRS) {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) continue;
    for (const file of fs.readdirSync(full)) {
      const target = path.join(full, file);
      if (!fs.statSync(target).isFile()) continue;
      if (file.endsWith('.html')) keysFromHtml(target).forEach((key) => used.add(key));
      if (file.endsWith('.js')) keysFromScript(target).forEach((key) => used.add(key));
    }
  }
  return used;
}

function main() {
  const strict = process.argv.includes('--strict');
  const base = i18n.loadCatalog('en');
  const catalogKeys = Object.keys(base).sort();
  const locales = i18n.availableLocales();

  const used = collectUsedKeys();
  const resolved = new Set();
  for (const key of used) expandTemplate(key, catalogKeys).forEach((item) => resolved.add(item));

  const missing = [...resolved].filter((key) => !(key in base)).sort();
  const placeholders = new Set();
  for (const [key, value] of Object.entries(base)) {
    if (typeof value !== 'string') continue;
    for (const token of value.match(/\{\w+\}/g) || []) placeholders.add(token);
    if (!value.trim()) missing.push(`${key} (boş metin)`);
  }

  console.log(`diller: ${locales.map((meta) => meta.code).join(', ')}`);
  console.log(`katalog anahtarı: ${catalogKeys.length}`);
  console.log(`kodda kullanılan: ${resolved.size}`);
  console.log(missing.length ? `HATA eksik anahtar: ${missing.join(', ')}` : 'HATA: yok');

  let incomplete = 0;
  const badVars = [];
  for (const meta of locales) {
    if (meta.code === i18n.BASE_LOCALE) continue;
    const dict = i18n.loadCatalog(meta.code);
    const absent = catalogKeys.filter((key) => !(key in dict));
    const extra = Object.keys(dict).filter((key) => !(key in base));
    const percent = ((catalogKeys.length - absent.length) / catalogKeys.length) * 100;

    // Yer tutucu kümesi İngilizce'yle aynı olmalı: {count} düşen bir çeviri
    // sayıyı sessizce kaybeder, {name} fazlası ekranda ham {name} bırakır.
    for (const key of catalogKeys) {
      if (!(key in dict)) continue;
      const want = (String(base[key]).match(/\{\w+\}/g) || []).sort().join(',');
      const got = (String(dict[key]).match(/\{\w+\}/g) || []).sort().join(',');
      if (want !== got) badVars.push(`${meta.code}:${key} [${want}] ≠ [${got}]`);
    }

    console.log(
      `${meta.code.padEnd(3)} ${percent.toFixed(1).padStart(5)}%  eksik ${absent.length}` +
        (absent.length && absent.length <= 12 ? `  (${absent.join(', ')})` : '') +
        (extra.length ? `  FAZLA: ${extra.join(', ')}` : '')
    );
    if (absent.length) incomplete += 1;
  }

  if (badVars.length) {
    console.log(`HATA yer tutucu uyuşmazlığı (${badVars.length}):`);
    for (const line of badVars.slice(0, 40)) console.log(`  ${line}`);
  }

  if (missing.length || badVars.length) process.exitCode = 1;
  else if (strict && incomplete) process.exitCode = 1;
}

main();
