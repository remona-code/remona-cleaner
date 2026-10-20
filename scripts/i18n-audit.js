'use strict';

/**
 * Translation audit.
 *
 * Verifies three things:
 *
 *   1. Does every key used by the code and HTML exist in the English catalogue?
 *      The interface (data-i18n* attributes and t('...') calls), the engine and
 *      the main process (i18n.t('...') calls) are scanned together. A missing
 *      key reaches the user as a raw `cat.foo.name`, so it is an error.
 *   2. Which key is missing in each translation catalogue? A missing key falls
 *      back to English, so it is not an error; it is reported as coverage.
 *   3. Does a catalogue contain a key that English no longer has?
 *
 * Usage: node scripts/i18n-audit.js [--strict]
 *   --strict  also fail when a language is only partly translated (for CI).
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

/** t('key') and t(`key.${x}`) forms; templates are resolved afterwards. */
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

/** Matches templates such as `view.${view}.title` against concrete catalogue keys. */
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
    if (!value.trim()) missing.push(`${key} (empty text)`);
  }

  console.log(`languages: ${locales.map((meta) => meta.code).join(', ')}`);
  console.log(`catalogue keys: ${catalogKeys.length}`);
  console.log(`used in code: ${resolved.size}`);
  console.log(missing.length ? `ERROR missing key: ${missing.join(', ')}` : 'ERROR: none');

  let incomplete = 0;
  const badVars = [];
  for (const meta of locales) {
    if (meta.code === i18n.BASE_LOCALE) continue;
    const dict = i18n.loadCatalog(meta.code);
    const absent = catalogKeys.filter((key) => !(key in dict));
    const extra = Object.keys(dict).filter((key) => !(key in base));
    const percent = ((catalogKeys.length - absent.length) / catalogKeys.length) * 100;

      // The placeholder set must match English: a translation that drops {count}
      // silently loses the number, and an extra {name} leaves raw {name} on screen.
    for (const key of catalogKeys) {
      if (!(key in dict)) continue;
      const want = (String(base[key]).match(/\{\w+\}/g) || []).sort().join(',');
      const got = (String(dict[key]).match(/\{\w+\}/g) || []).sort().join(',');
      if (want !== got) badVars.push(`${meta.code}:${key} [${want}] ≠ [${got}]`);
    }

    console.log(
      `${meta.code.padEnd(3)} ${percent.toFixed(1).padStart(5)}%  missing ${absent.length}` +
        (absent.length && absent.length <= 12 ? `  (${absent.join(', ')})` : '') +
        (extra.length ? `  EXTRA: ${extra.join(', ')}` : '')
    );
    if (absent.length) incomplete += 1;
  }

  if (badVars.length) {
    console.log(`ERROR placeholder mismatch (${badVars.length}):`);
    for (const line of badVars.slice(0, 40)) console.log(`  ${line}`);
  }

  if (missing.length || badVars.length) process.exitCode = 1;
  else if (strict && incomplete) process.exitCode = 1;
}

main();
