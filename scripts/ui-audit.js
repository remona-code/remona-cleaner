'use strict';

/**
 * Interface consistency audit.
 *
 * Is every `$('#id')` selector in `app.js` defined in `index.html`?
 * An undefined id raises a `null.textContent` error and leaves the interface
 * half-rendered; this audit catches that class of bug before any build.
 *
 * Usage: node scripts/ui-audit.js
 */

const fs = require('fs');
const path = require('path');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');

function idsInHtml(text) {
  const ids = new Set();
  for (const match of text.matchAll(/\bid="([^"]+)"/g)) ids.add(match[1]);
  return ids;
}

function idsUsedInScript(text) {
  const used = new Set();
  // $('  #id') ve $$('  #id')
  for (const match of text.matchAll(/\$\$?\(\s*'#([A-Za-z0-9_-]+)'/g)) used.add(match[1]);
  // getElementById('id')
  for (const match of text.matchAll(/getElementById\(\s*'([^']+)'/g)) used.add(match[1]);
  return used;
}

function main() {
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');

  const defined = idsInHtml(html);
  const used = idsUsedInScript(script);
  const missing = [...used].filter((id) => !defined.has(id)).sort();
  const unused = [...defined].filter((id) => !used.has(id)).sort();

  console.log(`html id: ${defined.size}`);
  console.log(`ids used in scripts: ${used.size}`);
  console.log(missing.length ? `ERROR undefined id: ${missing.join(', ')}` : 'ERROR: none');
  if (unused.length) console.log(`info (css/html only): ${unused.join(', ')}`);

  if (missing.length) process.exitCode = 1;
}

main();
