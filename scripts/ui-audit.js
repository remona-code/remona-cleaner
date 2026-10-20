'use strict';

/**
 * Arayüz tutarlılık denetimi.
 *
 * `app.js` içindeki `$('#id')` seçicilerinin tamamı `index.html`'de tanımlı mı?
 * Tanımsız bir id `null.textContent` hatası verir ve arayüz sessizce yarım
 * kalır; bu denetim o sınıf hatayı derlemeden önce yakalar.
 *
 * Kullanım: node scripts/ui-audit.js
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
  console.log(`betikte kullanılan id: ${used.size}`);
  console.log(missing.length ? `HATA tanımsız id: ${missing.join(', ')}` : 'HATA: yok');
  if (unused.length) console.log(`bilgi (yalnızca css/html): ${unused.join(', ')}`);

  if (missing.length) process.exitCode = 1;
}

main();
