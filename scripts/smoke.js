'use strict';

/**
 * Engine smoke test — scans the real system without opening the interface.
 *
 * It deletes, moves and changes nothing; it only reads.
 * Usage: npm run smoke   (for a deep scan: node scripts/smoke.js --deep)
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
  console.log('reMona (AICleaner) engine smoke test');
  console.log(`Deep scan: ${DEEP ? 'yes' : 'no'}`);
  console.log(`Data folder: ${config.DATA_DIR}`);
  console.log(line('='));

  // ---------------------------------------------------------------- disk
  const disk = await scanner.diskInfo();
  console.log('\nDRIVES');
  for (const drive of disk.drives) {
    console.log(
      `  ${pad(drive.drive, 6)} ${padLeft(drive.total_h, 10)} total  ` +
        `${padLeft(drive.free_h, 10)} free  ${padLeft(drive.percent, 3)}% used`
    );
  }
  if (!disk.drives.length) console.log('  drive information could not be read');

  // ------------------------------------------------------- recycle bin
  console.log('\nRECYCLE BIN');
  const bin = await trash.stats({ refresh: true });
  if (bin.ok) {
    console.log(`  ${bin.count} items, ${bin.size_h || bin.size + ' B'} (source: ${bin.source || 'shell'})`);
  } else {
    console.log(`  could not be read: ${bin.error}`);
  }

  // ---------------------------------------------------------------- scan
  console.log('\nSCAN');
  let lastStage = '';
  const result = await scanner.scan({
    deep: DEEP,
    onProgress: (p) => {
      if (p.stage !== lastStage) {
        lastStage = p.stage;
        console.log(`  [${padLeft(p.percent, 3)}%] ${p.stage}`);
      }
    },
  });

  console.log(`\n  Duration: ${result.duration} s`);
  console.log(`  Total junk: ${result.totals.all_h} (${result.totals.file_count} files)`);
  console.log(`  Safe: ${result.totals.safe_h} | Review: ${result.totals.caution_h} | Risky: ${result.totals.risky_h}`);

  console.log('\n  CATEGORIES');
  const ranked = [...result.categories].sort((a, b) => b.size - a.size);
  for (const cat of ranked) {
    const risk = { safe: 'safe', caution: 'review', risky: 'risky' }[cat.risk];
    const note = cat.note ? ` (${cat.note})` : '';
    console.log(
      `    ${pad(cat.name, 30)} ${padLeft(cat.size_h, 10)}  ` +
        `${padLeft(cat.file_count, 6)} files  ${pad(risk, 9)}${note}`
    );
  }

  // -------------------------------------------------------------------- AI
  const view = scanner.publicView(result);
  const analysis = await ai.analyze(result);
  console.log('\nAI ANALYSIS');
  console.log(`  Summary: ${analysis.summary}`);
  console.log(`  Recommended gain: ${analysis.potential.recommended_h} (${analysis.recommended_ids.length} categories)`);
  for (const insight of analysis.insights) {
    console.log(`  [${pad(insight.level, 5)}] ${insight.title}`);
  }

  const pick = await ai.smartPick(result, 5 * 1024 ** 3);
  console.log('\nSMART SELECTION (target 5.0 GB)');
  console.log(
    `  Selected: ${pick.size_h} / ${pick.target_h}  ` +
      `target reached: ${pick.reached ? 'yes' : 'no'}` +
      (pick.shortfall_h ? `  shortfall: ${pick.shortfall_h}` : '')
  );
  console.log(`  Categories: ${pick.category_ids.join(', ') || '(none)'}`);

  const provider = await ai.providerStatus();
  console.log('\nAI ENGINE');
  console.log(`  ${provider.engine}${provider.model ? ':' + provider.model : ''} - ${provider.note || ''}`);

  // ---------------------------------------------------------- other state
  const usage = await cleaner.quarantineUsage();
  const history = await store.getHistory();
  const settings = await store.getSettings();
  const roots = await cleaner.allowedDeleteRoots();

  console.log('\nSTATE');
  console.log(`  Quarantine: ${usage.sessions} sessions, ${usage.files} files, ${usage.size_h}`);
  console.log(`  Cleanup history: ${history.length} entries`);
  console.log(`  Clean mode: ${settings.clean_mode} | deep by default: ${settings.deep_scan}`);
  console.log(`  Roots allowed for deletion: ${roots.length}`);
  console.log(`  Categories sent to the interface: ${view.categories.length}`);

  // Full paths must not leak into the data the interface sees.
  const leaked = JSON.stringify(view).includes('_full');
  console.log(`  Hidden file list leak: ${leaked ? 'YES (bug)' : 'none'}`);

  console.log(`\n${line('=')}`);
  console.log(leaked ? 'RESULT: PROBLEM FOUND' : 'RESULT: OK');
  console.log(line('='));

  if (leaked) process.exitCode = 1;
}

main().catch((err) => {
  console.error('\nUNEXPECTED ERROR:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
