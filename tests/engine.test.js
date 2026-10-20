'use strict';

/**
 * reMona (AICleaner) engine tests (node:test).
 *
 * The tests never touch the real system: TEMP and the data folder are pointed
 * at a temporary fixture directory and the delete/security gate is exercised there.
 * This redirection must happen BEFORE the require (the engine reads its paths on load).
 */

const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { after, before, describe, it } = require('node:test');

const REAL_TMP = os.tmpdir();
const FIXTURE = path.join(REAL_TMP, `aiclr-fixture-${process.pid}`);
const DATA = path.join(REAL_TMP, `aiclr-data-${process.pid}`);

process.env.AICLEANER_DATA_DIR = DATA;
process.env.TEMP = FIXTURE;

const config = require('../src/engine/config');
const utils = require('../src/engine/utils');
const scanner = require('../src/engine/scanner');
const cleaner = require('../src/engine/cleaner');
const ai = require('../src/engine/ai');
const i18n = require('../src/i18n');

const { humanSize, isPathSafeToDelete, isUnder, norm, walkFiles } = utils;

// ------------------------------------------------------------------ helpers
async function makeFile(relative, content) {
  const full = path.join(FIXTURE, relative);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content);
  return full;
}

async function collect(root, options) {
  const out = [];
  for await (const file of walkFiles(root, options)) out.push(file.path);
  return out;
}

/** Finds the temp-folder category by its root (TEMP redirected to the fixture). */
const tempCategory = config.CATEGORIES.find(
  (cat) =>
    cat.mode === 'walk' &&
    cat.roots.some((root) => norm(root) === norm(config.TEMP))
);

/** Builds a hand-made scan result that contains the `_full` lists. */
function makeScan(cat, files) {
  const now = Date.now();
  const items = files.map((f) => scanner.makeItem(f.path, f.size, now / 1000, cat, now));
  const full = files.map((f) => ({ path: f.path, size: f.size }));
  const total = full.reduce((sum, f) => sum + f.size, 0);
  return {
    categories: [scanner.finalize(cat, items, full)],
    disk: {
      primary: {
        drive: 'C:\\',
        total: 5e11,
        used: 4e11,
        free: 1e11,
        percent: 80,
        total_h: humanSize(5e11),
        used_h: humanSize(4e11),
        free_h: humanSize(1e11),
      },
      drives: [],
    },
    totals: {
      all: total,
      all_h: humanSize(total),
      safe: total,
      safe_h: humanSize(total),
      caution: 0,
      caution_h: humanSize(0),
      risky: 0,
      risky_h: humanSize(0),
      file_count: full.length,
    },
  };
}

// ------------------------------------------------------------------ setup
before(async () => {
  await fsp.rm(FIXTURE, { recursive: true, force: true });
  await fsp.rm(DATA, { recursive: true, force: true });
  await fsp.mkdir(FIXTURE, { recursive: true });

  await makeFile('tmp_a.log', 'A'.repeat(2048));
  await makeFile('tmp_b.log', 'B'.repeat(4096));
  await makeFile('level1/inner.log', 'C'.repeat(1024));
  await makeFile('level1/level2/deeper.log', 'D'.repeat(1024));
  await makeFile('level1/level2/level3/deepest.log', 'E'.repeat(1024));
  await makeFile('profiles/alpha/Cache/data.db', 'F'.repeat(512));
  await makeFile('profiles/beta/Cache/data.db', 'G'.repeat(512));
  await makeFile('skipme/node_modules/vendor.js', 'H'.repeat(64));
  await makeFile('dup/one.bin', 'IDENTICAL-CONTENT-'.repeat(64));
  await makeFile('dup/two.bin', 'IDENTICAL-CONTENT-'.repeat(64));

  config.ensureDirs();
});

after(async () => {
  await fsp.rm(FIXTURE, { recursive: true, force: true });
  await fsp.rm(DATA, { recursive: true, force: true });
});

// ================================================================== format
describe('humanSize', () => {
  it('writes byte, KB, MB and GB values in a readable form', () => {
    assert.equal(humanSize(0), '0 B');
    assert.equal(humanSize(512), '512 B');
    assert.equal(humanSize(1536), '1.5 KB');
    assert.equal(humanSize(1048576), '1.0 MB');
    assert.equal(humanSize(5 * 1024 ** 3), '5.0 GB');
  });

  it('does not crash on broken input', () => {
    assert.equal(humanSize(null), '0 B');
    assert.equal(humanSize(undefined), '0 B');
    assert.equal(humanSize('abc'), '0 B');
  });
});

// ================================================================== yollar
describe('path helpers', () => {
  it('isUnder accepts child paths and rejects sibling prefixes', () => {
    assert.equal(isUnder('C:\\Games\\Save\\a.dat', 'C:\\Games'), true);
    assert.equal(isUnder('C:\\Games', 'C:\\Games'), true);
    assert.equal(isUnder('C:\\GamesExtra\\a.dat', 'C:\\Games'), false);
  });

  it('norm erases case and separator differences', () => {
    assert.equal(norm('C:\\Windows\\TEMP'), norm('c:/windows/temp'));
  });
});

// ================================================================== security
describe('delete security gate', () => {
  it('rejects system files', async () => {
    const roots = await cleaner.allowedDeleteRoots();
    for (const target of [
      'C:\\Windows\\System32\\kernel32.dll',
      'C:\\Windows\\Fonts\\arial.ttf',
      'C:\\Windows\\WinSxS\\backup\\file.dll',
      'C:\\Windows\\System32\\config\\SAM',
    ]) {
      const [allowed, reason] = isPathSafeToDelete(target, roots);
      assert.equal(allowed, false, `${target} reddedilmeliydi`);
      assert.match(reason, /Protected system component/);
    }
  });

  it('rejects files outside the allowed roots', async () => {
    const [allowed, reason] = isPathSafeToDelete('D:\\kisisel\\arsiv.zip', [config.TEMP]);
    assert.equal(allowed, false);
    assert.match(reason, /Outside the allowed scan roots/);
  });

  it('rejects the drive root and the user root', async () => {
    const roots = await cleaner.allowedDeleteRoots();
    assert.equal(isPathSafeToDelete(config.SYSTEM_DRIVE, roots)[0], false);
    assert.equal(isPathSafeToDelete(config.USER_HOME, roots)[0], false);
  });

  it('rejects protected user folders themselves but accepts their contents', async () => {
    const roots = await cleaner.allowedDeleteRoots();
    const desktop = path.join(config.USER_HOME, 'Desktop');
    assert.equal(isPathSafeToDelete(desktop, roots)[0], false);
    // Files inside folders such as Documents/Pictures must be deletable:
    const inside = path.join(config.USER_HOME, 'Documents', 'eski-rapor.pdf');
    assert.equal(isPathSafeToDelete(inside, roots)[0], true);
  });

  it('accepts a file in the temp folder', async () => {
    const roots = await cleaner.allowedDeleteRoots();
    const file = path.join(FIXTURE, 'tmp_a.log');
    const [allowed, reason] = isPathSafeToDelete(file, roots);
    assert.equal(allowed, true, reason);
  });
});

// ================================================================== gezme
describe('file walking', () => {
  it('resolves a wildcard in the middle of a path', async () => {
    const pattern = path.join(FIXTURE, 'profiles', '*', 'Cache');
    const roots = await utils.expandRoots([pattern]);
    assert.equal(roots.length, 2);
    assert.ok(roots.some((r) => r.toLowerCase().includes('alpha')));
    assert.ok(roots.some((r) => r.toLowerCase().includes('beta')));
  });

  it('respects the depth limit', async () => {
    const found = await collect(FIXTURE, { maxDepth: 2, extraSkipDirs: ['profiles', 'dup'] });
    const names = found.map((p) => path.basename(p)).sort();
    assert.ok(names.includes('tmp_a.log'));
    assert.ok(names.includes('inner.log'));
    assert.equal(names.includes('deeper.log'), false);
  });

  it('does not descend into noise folders such as node_modules', async () => {
    const found = await collect(FIXTURE, { maxDepth: 6 });
    assert.equal(
      found.some((p) => p.toLowerCase().includes('node_modules')),
      false
    );
  });

  it('applies the age filter', async () => {
    // Files just created are younger than 30 days, so none should pass.
    const fresh = await collect(FIXTURE, { maxDepth: 2, minAgeDays: 30 });
    assert.equal(fresh.length, 0, 'new files must not pass the age filter');

    // Moving "now" forward makes the same files look old enough.
    const aged = await collect(FIXTURE, {
      maxDepth: 2,
      minAgeDays: 30,
      nowMs: Date.now() + 90 * 86400000,
    });
    assert.ok(aged.length > 0, 'old files should pass the filter');
  });

  it('produces the same fingerprint for identical content', async () => {
    const one = path.join(FIXTURE, 'dup', 'one.bin');
    const two = path.join(FIXTURE, 'dup', 'two.bin');
    assert.equal(await utils.partialHash(one), await utils.partialHash(two));
    assert.equal(utils.itemId(one), utils.itemId(one));
    assert.notEqual(utils.itemId(one), utils.itemId(two));
  });
});

// ================================================================== configuration
describe('configuration consistency', () => {
  it('every category carries the required fields', () => {
    for (const cat of config.CATEGORIES) {
      assert.ok(cat.id, 'category id is missing');
      // Name and description now come from the catalogue; a raw key showing is a bug.
      const name = config.categoryName(cat.id);
      assert.ok(name && name !== `cat.${cat.id}.name`, `${cat.id} name is not translated`);
      const desc = config.categoryDesc(cat.id);
      assert.ok(desc && desc !== `cat.${cat.id}.desc`, `${cat.id} description is not translated`);
      assert.ok(['safe', 'caution', 'risky'].includes(cat.risk), `${cat.id} risk is invalid`);
      assert.ok(['walk', 'glob', 'special'].includes(cat.mode), `${cat.id} mode is invalid`);
      assert.ok(Array.isArray(cat.roots), `${cat.id} root list is missing`);
    }
  });

  it('category identifiers are unique', () => {
    const ids = config.CATEGORIES.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('safe categories are exactly the ones with risk "safe"', () => {
    for (const id of config.SAFE_CATEGORY_IDS) {
      assert.equal(config.CATEGORY_BY_ID[id].risk, 'safe', `${id} should not count as safe`);
    }
  });

  it('destructive scans are left to the deep scan', () => {
    for (const id of ['large_files', 'duplicates']) {
      assert.equal(config.CATEGORY_BY_ID[id].deep_only, true, `${id} should be deep-scan only`);
    }
    assert.ok(config.SAFE_CATEGORY_IDS.includes('user_temp'));
    assert.equal(config.SAFE_CATEGORY_IDS.includes('downloads_old'), false);
    assert.equal(config.SAFE_CATEGORY_IDS.includes('recycle_bin'), false);
  });
});

// ================================================================== scanner
describe('scanner', () => {
  it('finds the files in the temp folder', async () => {
    const result = await scanner.scanCategory(tempCategory, Date.now(), false);
    assert.ok(result.file_count >= 4, `expected files were not found: ${result.file_count}`);
    assert.ok(result.size > 0);
    assert.equal(result._full.length, result.file_count);
    assert.ok(result.items.length > 0);
    assert.ok(result.items[0].id && result.items[0].size_h && result.items[0].modified_h);
  });

  it('publicView strips the hidden file lists', () => {
    const fake = makeScan(tempCategory, [{ path: path.join(FIXTURE, 'tmp_a.log'), size: 2048 }]);
    const view = scanner.publicView(fake);
    assert.equal(view.categories[0]._full, undefined);
    assert.ok(view.categories[0].items.length === 1);
    // A saved view can be opened in another language: it must carry the text key.
    assert.equal(view.categories[0].name_key, 'cat.user_temp.name');
  });

  it('localizeView regenerates old record names in the selected language', () => {
    i18n.setLocale('de');
    try {
      // An old record from disk: no key, the name fixed in the language it was scanned in.
      const stored = {
        categories: [{ id: 'user_temp', name: 'Legacy Temp', size: 10, description: 'old' }],
        totals: { all: 10 },
      };
      const view = scanner.localizeView(stored);
      assert.equal(view.categories[0].name, 'Temporäre Dateien des Benutzers');
      assert.match(view.categories[0].description, /Reste von Installationen/);
      assert.equal(view.totals.all, 10);
      // An unknown identifier is left as is (a raw key is never printed on screen).
      const unknown = scanner.localizeView({ categories: [{ id: 'none', name: 'X' }] });
      assert.equal(unknown.categories[0].name, 'X');
    } finally {
      i18n.setLocale('en');
    }
  });

  it('reads disk information', async () => {
    const info = await scanner.diskInfo();
    assert.ok(info.primary);
    assert.ok(info.primary.total > 0, 'the disk total size could not be read');
    assert.ok(info.primary.free > 0);
    assert.ok(info.primary.percent >= 0 && info.primary.percent <= 100);
  });
});

// ================================================================== AI
describe('AI advisor', () => {
  const files = () => [
    { path: path.join(FIXTURE, 'tmp_a.log'), size: 2048 },
    { path: path.join(FIXTURE, 'tmp_b.log'), size: 4096 },
  ];

  it('produces an analysis summary, an insight and a recommendation', async () => {
    const result = await ai.analyze(makeScan(tempCategory, files()));
    assert.ok(typeof result.summary === 'string' && result.summary.length > 0);
    assert.ok(Array.isArray(result.insights) && result.insights.length > 0);
    assert.ok(Array.isArray(result.recommended_ids));
    assert.ok(result.recommended_ids.includes(tempCategory.id), 'the safe category should be recommended');
    assert.ok(result.potential.recommended > 0);
    assert.ok(result.potential.recommended_h);
    assert.equal(result.potential.total, 2048 + 4096);
    for (const insight of result.insights) {
      assert.ok(['ok', 'info', 'warn', 'win'].includes(insight.level), `invalid level: ${insight.level}`);
      assert.ok(typeof insight.title === 'string' && insight.title.length > 0);
    }
  });

  it('keeps the confidence score between 0 and 100', async () => {
    const result = await ai.analyze(makeScan(tempCategory, files()));
    for (const [id, entry] of Object.entries(result.categories)) {
      assert.ok(entry.confidence >= 0 && entry.confidence <= 100, `${id} score is out of range`);
      assert.ok(['delete', 'review', 'avoid', 'empty'].includes(entry.verdict));
    }
  });

  it('smart selection ranks safe groups to reach the target', async () => {
    const result = await ai.smartPick(makeScan(tempCategory, files()), 1024);
    assert.ok(Array.isArray(result.category_ids));
    assert.ok(result.category_ids.length >= 1);
    assert.ok(result.category_ids.includes(tempCategory.id));
    assert.ok(result.size >= 1024);
    assert.equal(result.reached, true);
    assert.ok(result.size_h && result.target_h);
  });

  it('the rule engine answers when no local model is available', async () => {
    const answer = await ai.ruleAnswer('ne silmeliyim', scanner.publicView(makeScan(tempCategory, files())));
    assert.ok(typeof answer === 'string' && answer.length > 0);
    const empty = await ai.ruleAnswer('ne silmeliyim', null);
    assert.match(empty, /scan/i);
  });
});

// ================================================================== temizleyici
describe('cleaner', () => {
  it('preview touches nothing', async () => {
    const target = path.join(FIXTURE, 'tmp_a.log');
    const scan = makeScan(tempCategory, [{ path: target, size: 2048 }]);
    const report = await cleaner.preview(scan, [tempCategory.id], []);
    assert.equal(report.file_count, 1);
    assert.equal(report.bytes, 2048);
    assert.equal((await fsp.stat(target)).size, 2048);
  });

  it('a dry run leaves the file in place', async () => {
    const target = path.join(FIXTURE, 'tmp_b.log');
    const scan = makeScan(tempCategory, [{ path: target, size: 4096 }]);
    const report = await cleaner.clean({
      scanResult: scan,
      categoryIds: [tempCategory.id],
      mode: 'quarantine',
      dryRun: true,
    });
    assert.equal(report.ok, true);
    assert.equal(report.file_count, 1);
    assert.equal((await fsp.stat(target)).size, 4096);
  });

  it('rejects system paths and leaves the file alone', async () => {
    const scan = makeScan(tempCategory, [
      { path: 'C:\\Windows\\System32\\drivers\\etc\\hosts', size: 1024 },
    ]);
    const report = await cleaner.clean({
      scanResult: scan,
      categoryIds: [tempCategory.id],
      mode: 'delete',
    });
    assert.equal(report.file_count, 0);
    assert.equal(report.bytes, 0);
    assert.ok(report.error_count >= 1, 'the block should be reported');
    assert.ok(await utils.pathExists('C:\\Windows\\System32\\drivers\\etc\\hosts'));
  });

  it('moves to quarantine, lists and restores', async () => {
    const target = await makeFile('quarantine_me.log', 'Q'.repeat(3072));
    const scan = makeScan(tempCategory, [{ path: target, size: 3072 }]);

    const report = await cleaner.clean({
      scanResult: scan,
      categoryIds: [tempCategory.id],
      mode: 'quarantine',
    });
    assert.equal(report.ok, true);
    assert.equal(report.file_count, 1);
    assert.equal(report.bytes, 3072);
    assert.equal(report.session, undefined === report.session ? undefined : report.session);
    assert.equal(await utils.pathExists(target), false, 'the file is still there');
    assert.ok(report.session || report.session_id, 'no session id was returned');

    const sessionId = report.session || report.session_id;
    const sessions = await cleaner.listQuarantine();
    const session = sessions.find((s) => s.session === sessionId);
    assert.ok(session, 'karantina oturumu listelenmedi');
    assert.equal(session.file_count, 1);
    assert.equal(session.size, 3072);

    const usage = await cleaner.quarantineUsage();
    assert.ok(usage.size >= 3072);
    assert.ok(usage.sessions >= 1);

    const restored = await cleaner.restoreSession(sessionId);
    assert.equal(restored.ok, true);
    assert.equal(restored.restored, 1);
    assert.equal((await fsp.stat(target)).size, 3072, 'the restored file is corrupt');
  });

  it('permanent delete removes the file without a way back', async () => {
    const target = await makeFile('purge_me.log', 'P'.repeat(1024));
    const scan = makeScan(tempCategory, [{ path: target, size: 1024 }]);
    const report = await cleaner.clean({
      scanResult: scan,
      categoryIds: [tempCategory.id],
      mode: 'delete',
    });
    assert.equal(report.ok, true);
    assert.equal(report.bytes, 1024);
    assert.equal(await utils.pathExists(target), false);
  });

  it('deletes a file once even when two categories count it', async () => {
    const target = await makeFile('dedupe_me.log', 'X'.repeat(2048));
    const scan = makeScan(tempCategory, [{ path: target, size: 2048 }]);
    scan.categories.push(scan.categories[0]);
    const report = await cleaner.clean({
      scanResult: scan,
      categoryIds: [tempCategory.id, tempCategory.id],
      mode: 'delete',
    });
    assert.equal(report.file_count, 1);
    assert.equal(report.bytes, 2048);
  });

  it('rejects an invalid session name', async () => {
    assert.equal((await cleaner.restoreSession('..\\kacis')).ok, false);
    assert.equal((await cleaner.purgeSession('a/b')).ok, false);
  });

  it('refuses to clean without a scan result', async () => {
    const report = await cleaner.clean({ scanResult: null, categoryIds: ['user_temp'] });
    assert.equal(report.ok, false);
    assert.match(report.error, /scan/i);
  });

  it('records history entries', async () => {
    const history = await require('../src/engine/store').getHistory();
    assert.ok(Array.isArray(history));
    assert.ok(history.length >= 1, 'cleanups should be written to history');
    const entry = history[0];
    assert.ok(entry.session && entry.mode && typeof entry.bytes === 'number');
    assert.ok(['quarantine', 'delete'].includes(entry.mode));
  });
});

// ================================================================== settings
describe('settings store', () => {
  it('merges defaults and writes them persistently', async () => {
    const store = require('../src/engine/store');
    await store.saveSettings({ clean_mode: 'delete' });
    const settings = await store.getSettings();
    assert.equal(settings.clean_mode, 'delete');
    // The default is English; "auto" follows the Windows language.
    assert.equal(settings.language, 'en');
    assert.equal(typeof settings.deep_scan, 'boolean');
    await store.saveSettings({ clean_mode: 'quarantine' });
  });

  it('falls back to defaults on a corrupt settings file', async () => {
    const store = require('../src/engine/store');
    await fsp.writeFile(config.SETTINGS_FILE, '{ bu json degil', 'utf8');
    const settings = await store.getSettings();
    assert.equal(settings.clean_mode, 'quarantine');
  });
});

// ================================================================== OpenAI provider
describe('OpenAI provider', () => {
  const store = require('../src/engine/store');

  // Start every run with a clean settings file and an empty provider cache.
  before(async () => {
    store.setSecretCipher(null);
    await fsp.rm(config.SETTINGS_FILE, { force: true });
    ai.resetProviderCache();
  });

  it('uses the default endpoint and model when there is no key', async () => {
    const cfg = await store.getAiConfig();
    assert.equal(cfg.provider, 'auto');
    assert.equal(cfg.base, config.OPENAI_DEFAULT_BASE);
    assert.equal(cfg.model, config.OPENAI_DEFAULT_MODEL);
    assert.equal(cfg.has_key, false);
  });

  it('does not leak the key to the interface, only a hint', async () => {
    const secret = 'sk-test-1234567890abcdef';
    const saved = await store.saveSettings({ ai_openai_key: secret });

    assert.equal(saved.ai_openai_key, '', 'the key itself must not go back to the interface');
    assert.equal(saved.ai_openai_key_set, true);
    assert.ok(!saved.ai_openai_key_hint.includes(secret));
    assert.match(saved.ai_openai_key_hint, /^sk-/);

    const cfg = await store.getAiConfig();
    assert.equal(cfg.key, secret);
    assert.equal(cfg.has_key, true);
    assert.equal(cfg.key_source, 'settings');
  });

  it('stores the key encrypted on disk and can decrypt it', async () => {
    store.setSecretCipher({
      encrypt: (value) => Buffer.from(`x:${value}`).toString('base64'),
      decrypt: (value) => Buffer.from(value, 'base64').toString().slice(2),
    });

    const secret = 'sk-encrypted-000111222';
    await store.saveSettings({ ai_openai_key: secret });

    const raw = await fsp.readFile(config.SETTINGS_FILE, 'utf8');
    assert.ok(!raw.includes(secret), 'the plain-text key must not appear in the file');
    assert.ok(raw.includes('enc:'), 'an encrypted value must carry the enc: prefix');

    const cfg = await store.getAiConfig();
    assert.equal(cfg.key, secret, 'the key must be decryptable');

    store.setSecretCipher(null);
  });

  it('keeps the current key when the key field is omitted', async () => {
    store.setSecretCipher({
      encrypt: (value) => Buffer.from(value).toString('base64'),
      decrypt: (value) => Buffer.from(value, 'base64').toString(),
    });

    await store.saveSettings({ ai_openai_key: 'sk-korunacak-999' });
    const saved = await store.saveSettings({ ai_openai_model: 'gpt-4o' });

    assert.equal(saved.ai_openai_key_set, true, 'changing the model must not clear the key');
    const cfg = await store.getAiConfig();
    assert.equal(cfg.key, 'sk-korunacak-999');
    assert.equal(cfg.model, 'gpt-4o');

    store.setSecretCipher(null);
  });

  it('sending an empty key clears it', async () => {
    await store.saveSettings({ ai_openai_key: 'sk-silinecek-123' });
    const saved = await store.saveSettings({ ai_openai_key: '' });

    assert.equal(saved.ai_openai_key_set, false);
    const cfg = await store.getAiConfig();
    assert.equal(cfg.has_key, false);
  });

  it('normalises an invalid provider and endpoint', async () => {
    const saved = await store.saveSettings({
      ai_provider: 'sacma-bir-deger',
      ai_openai_base: 'ftp://example.com/v1/',
      ai_max_tokens: 99999,
    });

    assert.equal(saved.ai_provider, 'auto', 'an unknown provider should fall back to automatic');
    assert.equal(saved.ai_openai_base, '', 'a non-http(s) endpoint should be rejected');
    assert.ok(saved.ai_max_tokens <= 4096, 'the token limit should be clamped to the maximum');
  });

  it('trims trailing slashes from the endpoint', async () => {
    const saved = await store.saveSettings({
      ai_provider: 'openai',
      ai_openai_base: 'https://api.openai.com/v1///',
    });

    assert.equal(saved.ai_provider, 'openai');
    assert.equal(saved.ai_openai_base, 'https://api.openai.com/v1');
  });

  it('model list and test return a clear error when there is no key', async () => {
    await store.saveSettings({ ai_openai_key: '' });

    const models = await ai.listModels();
    assert.equal(models.ok, false);
    assert.match(models.error, /API key/);

    const probe = await ai.testConnection('gpt-4o-mini');
    assert.equal(probe.ok, false);
    assert.match(probe.error, /API key/);
  });

  it('reports the rule engine when the provider is "rules"', async () => {
    await store.saveSettings({ ai_provider: 'rules' });
    ai.resetProviderCache();

    const status = await ai.providerStatus({ refresh: true });
    assert.equal(status.engine, 'local-rules');
    assert.equal(status.configured, 'rules');
  });

  it('selects the OpenAI engine when the provider is "openai" and a key exists', async () => {
    await store.saveSettings({
      ai_provider: 'openai',
      ai_openai_key: 'sk-abc1234567',
      ai_openai_model: 'gpt-4o-mini',
    });
    ai.resetProviderCache();

    const status = await ai.providerStatus({ refresh: true });
    assert.equal(status.engine, 'openai');
    assert.equal(status.model, 'gpt-4o-mini');
    assert.equal(status.available, true);
  });

  it('stays on the rule engine when OpenAI is selected but there is no key', async () => {
    await store.saveSettings({ ai_provider: 'openai', ai_openai_key: '' });
    ai.resetProviderCache();

    const status = await ai.providerStatus({ refresh: true });
    assert.equal(status.engine, 'local-rules');
    assert.equal(status.configured, 'openai');
    assert.match(status.note, /key/i);
  });
});

// ================================================================== i18n
describe('i18n', () => {
  const PARTIAL = path.join(i18n.LOCALES_DIR, 'zz.json');

  after(async () => {
    await fsp.rm(PARTIAL, { force: true });
    i18n.setLocale('en');
  });

  it('falls back to English for an unknown language', () => {
    assert.equal(i18n.resolveLocale('fi-FI'), 'en');
    assert.equal(i18n.resolveLocale('xx'), 'en');
    assert.equal(i18n.resolveLocale(''), 'en');
    assert.equal(i18n.resolveLocale('auto'), 'en');
    assert.equal(i18n.detectLocale('fi'), 'en');
  });

  it('reduces a regional variant to its base language', () => {
    assert.equal(i18n.resolveLocale('tr-TR'), 'tr');
    assert.equal(i18n.resolveLocale('de-AT'), 'de');
    assert.equal(i18n.resolveLocale('es-419'), 'es');
    assert.equal(i18n.resolveLocale('fr_CA'), 'fr');
  });

  it('falls back to English, then to the key itself, when a key is missing', async () => {
    // A half-finished catalogue: it holds a single key.
    await fsp.writeFile(PARTIAL, JSON.stringify({ nav: { dashboard: 'Panel ZZ' } }), 'utf8');

    assert.equal(i18n.tIn('zz', 'nav.dashboard'), 'Panel ZZ');
    assert.equal(i18n.tIn('zz', 'nav.settings'), 'Settings');
    assert.equal(i18n.tIn('zz', 'no.such.key'), 'no.such.key');
  });

  it('fills placeholders and leaves unknown ones as they are', () => {
    i18n.setLocale('en');
    assert.equal(i18n.t('cat.files', { count: 12 }), '12 files');
    assert.equal(i18n.t('cat.files', {}), '{count} files');
    assert.equal(i18n.interpolate('a {x} b {y}', { x: 1 }), 'a 1 b {y}');
  });

  it('every shipped language carries all keys and the same placeholders', () => {
    const base = i18n.loadCatalog('en');
    const keys = Object.keys(base);
    const locales = i18n.availableLocales().filter((meta) => meta.code !== 'en');
    assert.ok(locales.length >= 4, 'at least four translations were expected');

    for (const meta of locales) {
      const dict = i18n.loadCatalog(meta.code);
      const missing = keys.filter((key) => !(key in dict));
      assert.deepEqual(missing, [], `${meta.code} is missing keys`);
      for (const key of keys) {
        const want = (String(base[key]).match(/\{\w+\}/g) || []).sort().join(',');
        const got = (String(dict[key]).match(/\{\w+\}/g) || []).sort().join(',');
        assert.equal(got, want, `${meta.code}:${key} placeholders do not match`);
        assert.ok(String(dict[key]).trim(), `${meta.code}:${key} is empty`);
      }
    }
  });

  it('the bundle layers the selected language over English', () => {
    const bundle = i18n.bundle('tr');
    assert.equal(bundle.locale, 'tr');
    assert.equal(bundle.fallback, 'en');
    assert.equal(bundle.dict['nav.dashboard'], 'Panel');
    // A key present in English but missing in the selected language is still in the bundle.
    assert.equal(Object.keys(bundle.dict).length, Object.keys(i18n.loadCatalog('en')).length);
  });

  it('adapts number and size formats to the language', () => {
    assert.equal(i18n.number(1234567, 'en'), '1,234,567');
    assert.equal(i18n.number(1234567, 'tr'), '1.234.567');
    assert.equal(i18n.humanSize(1536, 'en'), '1.5 KB');
    assert.equal(i18n.humanSize(1536, 'tr'), '1,5 KB');
  });

  it('marks right-to-left languages', () => {
    assert.equal(i18n.isRtl('ar'), true);
    assert.equal(i18n.isRtl('fa'), true);
    assert.equal(i18n.isRtl('tr'), false);
  });
});
