'use strict';

/**
 * package.json içindeki repository/homepage/bugs alanlarını doldurur.
 *
 * Kullanım: node scripts/set-repo-url.js <owner>/<repo>
 * publish.cmd tarafından çağrılır; depo adı ancak GitHub'da oluşturulduktan
 * sonra bilindiği için ayrı bir adım.
 */

const fs = require('fs');
const path = require('path');

const slug = process.argv[2];
if (!slug || !/^[\w.-]+\/[\w.-]+$/.test(slug)) {
  console.error('kullanım: node scripts/set-repo-url.js <owner>/<repo>');
  process.exit(1);
}

const file = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
const url = `https://github.com/${slug}`;

pkg.repository = { type: 'git', url: `git+${url}.git` };
pkg.homepage = `${url}#readme`;
pkg.bugs = { url: `${url}/issues` };

fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`package.json güncellendi: ${url}`);
