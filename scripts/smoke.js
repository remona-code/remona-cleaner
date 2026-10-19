'use strict';

/**
 * Motor duman testi — arayüz açmadan gerçek sistemi tarar.
 *
 * Hiçbir dosyayı silmez, taşımaz veya değiştirmez; yalnızca okur.
 * Kullanım: npm run smoke   (derin tarama için: node scripts/smoke.js --deep)
 */

const config = require('../src/engine/config');
const scanner = require('../src/engine/scanner');
const ai = require('../src/engine/ai');
const cleaner = require('../src/engine/cleaner');
const trash = require('../src/engine/trash');
const store = require('../src/engine/store');

const DEEP = process.argv.includes('--deep');

function line(char = '-', width = 62) {
  return char.repeat(width);
}

function pad(text, width) {
  const value = String(text);
  return value.length >= width ? value.slice(0, width) : value + ' '.repeat(width - value.length);
}

function padLeft(text, width) {
  const value = String(text);
  return value.length >= width ? value : ' '.repeat(width - value.length) + value;
}

async function main() {
  console.log(line('='));
  console.log('reMona (AICleaner) motor duman testi');
  console.log(`Derin tarama: ${DEEP ? 'evet' : 'hayir'}`);
  console.log(`Veri klasoru: ${config.DATA_DIR}`);
  console.log(line('='));

  // ---------------------------------------------------------------- disk
  const disk = await scanner.diskInfo();
  console.log('\nSURUCLER');
  for (const drive of disk.drives) {
    console.log(
      `  ${pad(drive.drive, 6)} ${padLeft(drive.total_h, 10)} toplam  ` +
        `${padLeft(drive.free_h, 10)} bos  %${padLeft(drive.percent, 3)} dolu`
    );
  }
  if (!disk.drives.length) console.log('  surucu bilgisi okunamadi');

  // ------------------------------------------------------- geri donusum
  console.log('\nGERI DONUSUM KUTUSU');
  const bin = await trash.stats({ refresh: true });
  if (bin.ok) {
    console.log(`  ${bin.count} oge, ${bin.size_h || bin.size + ' B'} (kaynak: ${bin.source || 'shell'})`);
  } else {
    console.log(`  okunamadi: ${bin.error}`);
  }

  // ---------------------------------------------------------------- tarama
  console.log('\nTARAMA');
  let lastStage = '';
  const result = await scanner.scan({
    deep: DEEP,
    onProgress: (p) => {
      if (p.stage !== lastStage) {
        lastStage = p.stage;
        console.log(`  [%${padLeft(p.percent, 3)}] ${p.stage}`);
      }
    },
  });

  console.log(`\n  Sure: ${result.duration} sn`);
  console.log(`  Toplam atik: ${result.totals.all_h} (${result.totals.file_count} dosya)`);
  console.log(`  Risksiz: ${result.totals.safe_h} | Dikkatli: ${result.totals.caution_h} | Riskli: ${result.totals.risky_h}`);

  console.log('\n  KATEGORILER');
  const ranked = [...result.categories].sort((a, b) => b.size - a.size);
  for (const cat of ranked) {
    const risk = { safe: 'guvenli', caution: 'dikkatli', risky: 'riskli' }[cat.risk];
    const note = cat.note ? ` (${cat.note})` : '';
    console.log(
      `    ${pad(cat.name, 30)} ${padLeft(cat.size_h, 10)}  ` +
        `${padLeft(cat.file_count, 6)} dosya  ${pad(risk, 9)}${note}`
    );
  }

  // -------------------------------------------------------------------- AI
  const view = scanner.publicView(result);
  const analysis = await ai.analyze(result);
  console.log('\nAI ANALIZI');
  console.log(`  Ozet: ${analysis.summary}`);
  console.log(`  Onerilen kazanc: ${analysis.potential.recommended_h} (${analysis.recommended_ids.length} kategori)`);
  for (const insight of analysis.insights) {
    console.log(`  [${pad(insight.level, 5)}] ${insight.title}`);
  }

  const pick = await ai.smartPick(result, 5 * 1024 ** 3);
  console.log('\nAKILLI SECIM (hedef 5.0 GB)');
  console.log(
    `  Secilen: ${pick.size_h} / ${pick.target_h}  ` +
      `hedefe ulasildi: ${pick.reached ? 'evet' : 'hayir'}` +
      (pick.shortfall_h ? `  eksik: ${pick.shortfall_h}` : '')
  );
  console.log(`  Kategoriler: ${pick.category_ids.join(', ') || '(yok)'}`);

  const provider = await ai.providerStatus();
  console.log('\nAI MOTORU');
  console.log(`  ${provider.engine}${provider.model ? ':' + provider.model : ''} - ${provider.note || ''}`);

  // ---------------------------------------------------------- diger durum
  const usage = await cleaner.quarantineUsage();
  const history = await store.getHistory();
  const settings = await store.getSettings();
  const roots = await cleaner.allowedDeleteRoots();

  console.log('\nDURUM');
  console.log(`  Karantina: ${usage.sessions} oturum, ${usage.files} dosya, ${usage.size_h}`);
  console.log(`  Gecmis temizlik: ${history.length} kayit`);
  console.log(`  Temizlik modu: ${settings.clean_mode} | derin varsayilan: ${settings.deep_scan}`);
  console.log(`  Silmeye izinli kok sayisi: ${roots.length}`);
  console.log(`  Arayuze gonderilen kategori sayisi: ${view.categories.length}`);

  // Arayüzün gördüğü veride tam yollar sızmamalı.
  const leaked = JSON.stringify(view).includes('_full');
  console.log(`  Gizli dosya listesi sizintisi: ${leaked ? 'VAR (hata)' : 'yok'}`);

  console.log(`\n${line('=')}`);
  console.log(leaked ? 'SONUC: SORUN VAR' : 'SONUC: TAMAM');
  console.log(line('='));

  if (leaked) process.exitCode = 1;
}

main().catch((err) => {
  console.error('\nBEKLENMEYEN HATA:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
