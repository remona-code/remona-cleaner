'use strict';

/**
 * reMona (AICleaner) motor testleri (node:test).
 *
 * Testler gerçek sisteme dokunmaz: TEMP ve veri klasörü geçici bir fixture
 * dizinine yönlendirilir, silme/güvenlik kapısı bu fixture üzerinde sınanır.
 * Bu yönlendirme require'dan ÖNCE yapılmalıdır (motor yolları yüklenirken okur).
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

// ------------------------------------------------------------------ yardımcı
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

/** Geçici klasör kategorisini köküne göre bulur (fixture'a yönlendirilmiş TEMP). */
const tempCategory = config.CATEGORIES.find(
  (cat) =>
    cat.mode === 'walk' &&
    cat.roots.some((root) => norm(root) === norm(config.TEMP))
);

/** Elle kurulmuş, `_full` listelerini içeren bir tarama sonucu üretir. */
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

// ------------------------------------------------------------------ hazırlık
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

// ================================================================== biçim
describe('humanSize', () => {
  it('bayt, KB, MB ve GB değerlerini okunur biçimde yazar', () => {
    assert.equal(humanSize(0), '0 B');
    assert.equal(humanSize(512), '512 B');
    assert.equal(humanSize(1536), '1.5 KB');
    assert.equal(humanSize(1048576), '1.0 MB');
    assert.equal(humanSize(5 * 1024 ** 3), '5.0 GB');
  });

  it('bozuk girdide çökmez', () => {
    assert.equal(humanSize(null), '0 B');
    assert.equal(humanSize(undefined), '0 B');
    assert.equal(humanSize('abc'), '0 B');
  });
});

// ================================================================== yollar
describe('yol yardımcıları', () => {
  it('isUnder alt yolları kabul eder, kardeş önekleri reddeder', () => {
    assert.equal(isUnder('C:\\Games\\Save\\a.dat', 'C:\\Games'), true);
    assert.equal(isUnder('C:\\Games', 'C:\\Games'), true);
    assert.equal(isUnder('C:\\GamesExtra\\a.dat', 'C:\\Games'), false);
  });

  it('norm büyük/küçük harf ve ayraç farkını yok eder', () => {
    assert.equal(norm('C:\\Windows\\TEMP'), norm('c:/windows/temp'));
  });
});

// ================================================================== güvenlik
describe('silme güvenlik kapısı', () => {
  it('sistem dosyalarını reddeder', async () => {
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

  it('izin verilen köklerin dışındaki dosyaları reddeder', async () => {
    const [allowed, reason] = isPathSafeToDelete('D:\\kisisel\\arsiv.zip', [config.TEMP]);
    assert.equal(allowed, false);
    assert.match(reason, /Outside the allowed scan roots/);
  });

  it('kök sürücüyü ve kullanıcı kökünü reddeder', async () => {
    const roots = await cleaner.allowedDeleteRoots();
    assert.equal(isPathSafeToDelete(config.SYSTEM_DRIVE, roots)[0], false);
    assert.equal(isPathSafeToDelete(config.USER_HOME, roots)[0], false);
  });

  it('korumalı kullanıcı klasörlerinin kendisini reddeder, içeriğini kabul eder', async () => {
    const roots = await cleaner.allowedDeleteRoots();
    const desktop = path.join(config.USER_HOME, 'Desktop');
    assert.equal(isPathSafeToDelete(desktop, roots)[0], false);
    // Belge/Resim gibi klasörlerin içindeki dosyalar silinebilir olmalı:
    const inside = path.join(config.USER_HOME, 'Documents', 'eski-rapor.pdf');
    assert.equal(isPathSafeToDelete(inside, roots)[0], true);
  });

  it('geçici klasördeki dosyayı kabul eder', async () => {
    const roots = await cleaner.allowedDeleteRoots();
    const file = path.join(FIXTURE, 'tmp_a.log');
    const [allowed, reason] = isPathSafeToDelete(file, roots);
    assert.equal(allowed, true, reason);
  });
});

// ================================================================== gezme
describe('dosya gezme', () => {
  it('joker karakteri yolun ortasında da çözer', async () => {
    const pattern = path.join(FIXTURE, 'profiles', '*', 'Cache');
    const roots = await utils.expandRoots([pattern]);
    assert.equal(roots.length, 2);
    assert.ok(roots.some((r) => r.toLowerCase().includes('alpha')));
    assert.ok(roots.some((r) => r.toLowerCase().includes('beta')));
  });

  it('derinlik sınırına uyar', async () => {
    const found = await collect(FIXTURE, { maxDepth: 2, extraSkipDirs: ['profiles', 'dup'] });
    const names = found.map((p) => path.basename(p)).sort();
    assert.ok(names.includes('tmp_a.log'));
    assert.ok(names.includes('inner.log'));
    assert.equal(names.includes('deeper.log'), false);
  });

  it('node_modules gibi gürültü klasörlerine girmez', async () => {
    const found = await collect(FIXTURE, { maxDepth: 6 });
    assert.equal(
      found.some((p) => p.toLowerCase().includes('node_modules')),
      false
    );
  });

  it('yaş süzgecini uygular', async () => {
    // Az önce oluşturulan dosyalar 30 günden genç olduğu için hiçbiri geçmemeli.
    const fresh = await collect(FIXTURE, { maxDepth: 2, minAgeDays: 30 });
    assert.equal(fresh.length, 0, 'yeni dosyalar yaş süzgecinden geçmemeliydi');

    // "Şimdi" ileri alınırsa aynı dosyalar yeterince yaşlı görünür.
    const aged = await collect(FIXTURE, {
      maxDepth: 2,
      minAgeDays: 30,
      nowMs: Date.now() + 90 * 86400000,
    });
    assert.ok(aged.length > 0, 'yaşlı dosyalar süzgeçten geçmeliydi');
  });

  it('aynı içerik için aynı parmak izini üretir', async () => {
    const one = path.join(FIXTURE, 'dup', 'one.bin');
    const two = path.join(FIXTURE, 'dup', 'two.bin');
    assert.equal(await utils.partialHash(one), await utils.partialHash(two));
    assert.equal(utils.itemId(one), utils.itemId(one));
    assert.notEqual(utils.itemId(one), utils.itemId(two));
  });
});

// ================================================================== yapılandırma
describe('yapılandırma tutarlılığı', () => {
  it('her kategori zorunlu alanları taşır', () => {
    for (const cat of config.CATEGORIES) {
      assert.ok(cat.id, 'kategori kimliği eksik');
      // Ad ve açıklama artık katalogdan gelir; ham anahtar görünmesi hatadır.
      const name = config.categoryName(cat.id);
      assert.ok(name && name !== `cat.${cat.id}.name`, `${cat.id} adı çevrilmemiş`);
      const desc = config.categoryDesc(cat.id);
      assert.ok(desc && desc !== `cat.${cat.id}.desc`, `${cat.id} açıklaması çevrilmemiş`);
      assert.ok(['safe', 'caution', 'risky'].includes(cat.risk), `${cat.id} riski geçersiz`);
      assert.ok(['walk', 'glob', 'special'].includes(cat.mode), `${cat.id} modu geçersiz`);
      assert.ok(Array.isArray(cat.roots), `${cat.id} kök listesi eksik`);
    }
  });

  it('kategori kimlikleri tekil', () => {
    const ids = config.CATEGORIES.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('güvenli kategoriler yalnızca riski "safe" olanlardır', () => {
    for (const id of config.SAFE_CATEGORY_IDS) {
      assert.equal(config.CATEGORY_BY_ID[id].risk, 'safe', `${id} güvenli sayılmamalıydı`);
    }
  });

  it('yıkıcı taramalar derin taramaya bırakılır', () => {
    for (const id of ['large_files', 'duplicates']) {
      assert.equal(config.CATEGORY_BY_ID[id].deep_only, true, `${id} derin taramada olmalıydı`);
    }
    assert.ok(config.SAFE_CATEGORY_IDS.includes('user_temp'));
    assert.equal(config.SAFE_CATEGORY_IDS.includes('downloads_old'), false);
    assert.equal(config.SAFE_CATEGORY_IDS.includes('recycle_bin'), false);
  });
});

// ================================================================== tarayıcı
describe('tarayıcı', () => {
  it('geçici klasördeki dosyaları bulur', async () => {
    const result = await scanner.scanCategory(tempCategory, Date.now(), false);
    assert.ok(result.file_count >= 4, `beklenen dosya bulunamadı: ${result.file_count}`);
    assert.ok(result.size > 0);
    assert.equal(result._full.length, result.file_count);
    assert.ok(result.items.length > 0);
    assert.ok(result.items[0].id && result.items[0].size_h && result.items[0].modified_h);
  });

  it('publicView gizli dosya listelerini temizler', () => {
    const fake = makeScan(tempCategory, [{ path: path.join(FIXTURE, 'tmp_a.log'), size: 2048 }]);
    const view = scanner.publicView(fake);
    assert.equal(view.categories[0]._full, undefined);
    assert.ok(view.categories[0].items.length === 1);
    // Kaydedilen görünüm başka dilde açılabilir: metin anahtarı taşınmalı.
    assert.equal(view.categories[0].name_key, 'cat.user_temp.name');
  });

  it('localizeView eski kayıttaki adları seçili dilde yeniden üretir', () => {
    i18n.setLocale('de');
    try {
      // Diskten gelen eski kayıt: anahtar yok, ad tarandığı dilde sabitlenmiş.
      const stored = {
        categories: [{ id: 'user_temp', name: 'Kullanıcı Geçici', size: 10, description: 'eski' }],
        totals: { all: 10 },
      };
      const view = scanner.localizeView(stored);
      assert.equal(view.categories[0].name, 'Temporäre Dateien des Benutzers');
      assert.match(view.categories[0].description, /Reste von Installationen/);
      assert.equal(view.totals.all, 10);
      // Bilinmeyen kimlik olduğu gibi bırakılır (ham anahtar ekrana basılmaz).
      const unknown = scanner.localizeView({ categories: [{ id: 'yok', name: 'X' }] });
      assert.equal(unknown.categories[0].name, 'X');
    } finally {
      i18n.setLocale('en');
    }
  });

  it('disk bilgisini okur', async () => {
    const info = await scanner.diskInfo();
    assert.ok(info.primary);
    assert.ok(info.primary.total > 0, 'disk toplam boyutu okunamadı');
    assert.ok(info.primary.free > 0);
    assert.ok(info.primary.percent >= 0 && info.primary.percent <= 100);
  });
});

// ================================================================== AI
describe('AI danışmanı', () => {
  const files = () => [
    { path: path.join(FIXTURE, 'tmp_a.log'), size: 2048 },
    { path: path.join(FIXTURE, 'tmp_b.log'), size: 4096 },
  ];

  it('analiz özeti, içgörü ve öneri üretir', async () => {
    const result = await ai.analyze(makeScan(tempCategory, files()));
    assert.ok(typeof result.summary === 'string' && result.summary.length > 0);
    assert.ok(Array.isArray(result.insights) && result.insights.length > 0);
    assert.ok(Array.isArray(result.recommended_ids));
    assert.ok(result.recommended_ids.includes(tempCategory.id), 'güvenli kategori önerilmeliydi');
    assert.ok(result.potential.recommended > 0);
    assert.ok(result.potential.recommended_h);
    assert.equal(result.potential.total, 2048 + 4096);
    for (const insight of result.insights) {
      assert.ok(['ok', 'info', 'warn', 'win'].includes(insight.level), `geçersiz seviye: ${insight.level}`);
      assert.ok(typeof insight.title === 'string' && insight.title.length > 0);
    }
  });

  it('güven skoru 0-100 arasında kalır', async () => {
    const result = await ai.analyze(makeScan(tempCategory, files()));
    for (const [id, entry] of Object.entries(result.categories)) {
      assert.ok(entry.confidence >= 0 && entry.confidence <= 100, `${id} skoru aralık dışı`);
      assert.ok(['sil', 'dikkatli', 'dokunma', 'boş'].includes(entry.verdict));
    }
  });

  it('akıllı seçim hedefe ulaşmak için güvenli grupları sıralar', async () => {
    const result = await ai.smartPick(makeScan(tempCategory, files()), 1024);
    assert.ok(Array.isArray(result.category_ids));
    assert.ok(result.category_ids.length >= 1);
    assert.ok(result.category_ids.includes(tempCategory.id));
    assert.ok(result.size >= 1024);
    assert.equal(result.reached, true);
    assert.ok(result.size_h && result.target_h);
  });

  it('yerel model yokken kural motoru yanıtlar', async () => {
    const answer = await ai.ruleAnswer('ne silmeliyim', scanner.publicView(makeScan(tempCategory, files())));
    assert.ok(typeof answer === 'string' && answer.length > 0);
    const empty = await ai.ruleAnswer('ne silmeliyim', null);
    assert.match(empty, /scan/i);
  });
});

// ================================================================== temizleyici
describe('temizleyici', () => {
  it('önizleme hiçbir şeye dokunmaz', async () => {
    const target = path.join(FIXTURE, 'tmp_a.log');
    const scan = makeScan(tempCategory, [{ path: target, size: 2048 }]);
    const report = await cleaner.preview(scan, [tempCategory.id], []);
    assert.equal(report.file_count, 1);
    assert.equal(report.bytes, 2048);
    assert.equal((await fsp.stat(target)).size, 2048);
  });

  it('kuru çalıştırma dosyayı yerinde bırakır', async () => {
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

  it('sistem yollarını reddeder ve dosyaya dokunmaz', async () => {
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
    assert.ok(report.error_count >= 1, 'engelleme raporlanmalıydı');
    assert.ok(await utils.pathExists('C:\\Windows\\System32\\drivers\\etc\\hosts'));
  });

  it('karantinaya taşır, listeler ve geri yükler', async () => {
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
    assert.equal(await utils.pathExists(target), false, 'dosya hâlâ yerinde');
    assert.ok(report.session || report.session_id, 'oturum kimliği dönmedi');

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
    assert.equal((await fsp.stat(target)).size, 3072, 'geri yüklenen dosya bozuk');
  });

  it('kalıcı silme dosyayı geri dönüşü olmadan kaldırır', async () => {
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

  it('aynı dosyayı iki kategoride birden saysa bile bir kez siler', async () => {
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

  it('geçersiz oturum adını reddeder', async () => {
    assert.equal((await cleaner.restoreSession('..\\kacis')).ok, false);
    assert.equal((await cleaner.purgeSession('a/b')).ok, false);
  });

  it('tarama sonucu olmadan temizlik istemez', async () => {
    const report = await cleaner.clean({ scanResult: null, categoryIds: ['user_temp'] });
    assert.equal(report.ok, false);
    assert.match(report.error, /scan/i);
  });

  it('geçmiş kaydını tutar', async () => {
    const history = await require('../src/engine/store').getHistory();
    assert.ok(Array.isArray(history));
    assert.ok(history.length >= 1, 'temizlikler geçmişe yazılmalıydı');
    const entry = history[0];
    assert.ok(entry.session && entry.mode && typeof entry.bytes === 'number');
    assert.ok(['quarantine', 'delete'].includes(entry.mode));
  });
});

// ================================================================== ayarlar
describe('ayar deposu', () => {
  it('varsayılanları birleştirir ve kalıcı yazar', async () => {
    const store = require('../src/engine/store');
    await store.saveSettings({ clean_mode: 'delete' });
    const settings = await store.getSettings();
    assert.equal(settings.clean_mode, 'delete');
    // Varsayılan "auto": arayüz Windows dilini izler.
    assert.equal(settings.language, 'auto');
    assert.equal(typeof settings.deep_scan, 'boolean');
    await store.saveSettings({ clean_mode: 'quarantine' });
  });

  it('bozuk ayar dosyasında varsayılana döner', async () => {
    const store = require('../src/engine/store');
    await fsp.writeFile(config.SETTINGS_FILE, '{ bu json degil', 'utf8');
    const settings = await store.getSettings();
    assert.equal(settings.clean_mode, 'quarantine');
  });
});

// ================================================================== OpenAI sağlayıcısı
describe('OpenAI sağlayıcısı', () => {
  const store = require('../src/engine/store');

  // Her koşuda temiz bir ayar dosyası ve boş sağlayıcı önbelleğiyle başla.
  before(async () => {
    store.setSecretCipher(null);
    await fsp.rm(config.SETTINGS_FILE, { force: true });
    ai.resetProviderCache();
  });

  it('anahtar yokken varsayılan uç nokta ve modeli kullanır', async () => {
    const cfg = await store.getAiConfig();
    assert.equal(cfg.provider, 'auto');
    assert.equal(cfg.base, config.OPENAI_DEFAULT_BASE);
    assert.equal(cfg.model, config.OPENAI_DEFAULT_MODEL);
    assert.equal(cfg.has_key, false);
  });

  it('anahtarı arayüze sızdırmaz, yalnızca ipucu verir', async () => {
    const secret = 'sk-test-1234567890abcdef';
    const saved = await store.saveSettings({ ai_openai_key: secret });

    assert.equal(saved.ai_openai_key, '', 'anahtarın kendisi arayüze dönmemeli');
    assert.equal(saved.ai_openai_key_set, true);
    assert.ok(!saved.ai_openai_key_hint.includes(secret));
    assert.match(saved.ai_openai_key_hint, /^sk-/);

    const cfg = await store.getAiConfig();
    assert.equal(cfg.key, secret);
    assert.equal(cfg.has_key, true);
    assert.equal(cfg.key_source, 'settings');
  });

  it('anahtarı diskte şifreli saklar ve geri çözebilir', async () => {
    store.setSecretCipher({
      encrypt: (value) => Buffer.from(`x:${value}`).toString('base64'),
      decrypt: (value) => Buffer.from(value, 'base64').toString().slice(2),
    });

    const secret = 'sk-encrypted-000111222';
    await store.saveSettings({ ai_openai_key: secret });

    const raw = await fsp.readFile(config.SETTINGS_FILE, 'utf8');
    assert.ok(!raw.includes(secret), 'düz metin anahtar dosyada bulunmamalı');
    assert.ok(raw.includes('enc:'), 'şifreli değer enc: önekli olmalı');

    const cfg = await store.getAiConfig();
    assert.equal(cfg.key, secret, 'anahtar geri çözülebilmeli');

    store.setSecretCipher(null);
  });

  it('anahtar alanı gönderilmezse mevcut anahtarı korur', async () => {
    store.setSecretCipher({
      encrypt: (value) => Buffer.from(value).toString('base64'),
      decrypt: (value) => Buffer.from(value, 'base64').toString(),
    });

    await store.saveSettings({ ai_openai_key: 'sk-korunacak-999' });
    const saved = await store.saveSettings({ ai_openai_model: 'gpt-4o' });

    assert.equal(saved.ai_openai_key_set, true, 'model değişimi anahtarı silmemeli');
    const cfg = await store.getAiConfig();
    assert.equal(cfg.key, 'sk-korunacak-999');
    assert.equal(cfg.model, 'gpt-4o');

    store.setSecretCipher(null);
  });

  it('boş anahtar gönderimi anahtarı siler', async () => {
    await store.saveSettings({ ai_openai_key: 'sk-silinecek-123' });
    const saved = await store.saveSettings({ ai_openai_key: '' });

    assert.equal(saved.ai_openai_key_set, false);
    const cfg = await store.getAiConfig();
    assert.equal(cfg.has_key, false);
  });

  it('geçersiz sağlayıcı ve uç noktayı normalize eder', async () => {
    const saved = await store.saveSettings({
      ai_provider: 'sacma-bir-deger',
      ai_openai_base: 'ftp://example.com/v1/',
      ai_max_tokens: 99999,
    });

    assert.equal(saved.ai_provider, 'auto', 'bilinmeyen sağlayıcı otomatiğe dönmeli');
    assert.equal(saved.ai_openai_base, '', 'http(s) olmayan uç nokta reddedilmeli');
    assert.ok(saved.ai_max_tokens <= 4096, 'token sınırı üst sınıra çekilmeli');
  });

  it('uç noktanın sondaki eğik çizgilerini temizler', async () => {
    const saved = await store.saveSettings({
      ai_provider: 'openai',
      ai_openai_base: 'https://api.openai.com/v1///',
    });

    assert.equal(saved.ai_provider, 'openai');
    assert.equal(saved.ai_openai_base, 'https://api.openai.com/v1');
  });

  it('anahtar yokken model listesi ve test anlaşılır hata döndürür', async () => {
    await store.saveSettings({ ai_openai_key: '' });

    const models = await ai.listModels();
    assert.equal(models.ok, false);
    assert.match(models.error, /API key/);

    const probe = await ai.testConnection('gpt-4o-mini');
    assert.equal(probe.ok, false);
    assert.match(probe.error, /API key/);
  });

  it('sağlayıcı "rules" iken kural motorunu bildirir', async () => {
    await store.saveSettings({ ai_provider: 'rules' });
    ai.resetProviderCache();

    const status = await ai.providerStatus({ refresh: true });
    assert.equal(status.engine, 'local-rules');
    assert.equal(status.configured, 'rules');
  });

  it('sağlayıcı "openai" ve anahtar varsa OpenAI motorunu seçer', async () => {
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

  it('anahtar yokken OpenAI seçili olsa da kural motorunda kalır', async () => {
    await store.saveSettings({ ai_provider: 'openai', ai_openai_key: '' });
    ai.resetProviderCache();

    const status = await ai.providerStatus({ refresh: true });
    assert.equal(status.engine, 'local-rules');
    assert.equal(status.configured, 'openai');
    assert.match(status.note, /key/i);
  });
});

// ================================================================== çok dillilik
describe('çok dillilik', () => {
  const PARTIAL = path.join(i18n.LOCALES_DIR, 'zz.json');

  after(async () => {
    await fsp.rm(PARTIAL, { force: true });
    i18n.setLocale('en');
  });

  it('bilinmeyen dili İngilizceye düşürür', () => {
    assert.equal(i18n.resolveLocale('fi-FI'), 'en');
    assert.equal(i18n.resolveLocale('xx'), 'en');
    assert.equal(i18n.resolveLocale(''), 'en');
    assert.equal(i18n.resolveLocale('auto'), 'en');
    assert.equal(i18n.detectLocale('fi'), 'en');
  });

  it('bölgesel varyantı ana dile indirger', () => {
    assert.equal(i18n.resolveLocale('tr-TR'), 'tr');
    assert.equal(i18n.resolveLocale('de-AT'), 'de');
    assert.equal(i18n.resolveLocale('es-419'), 'es');
    assert.equal(i18n.resolveLocale('fr_CA'), 'fr');
  });

  it('seçili dilde anahtar yoksa İngilizce, o da yoksa anahtar döner', async () => {
    // Yarım bir katalog: yalnızca tek anahtar içeriyor.
    await fsp.writeFile(PARTIAL, JSON.stringify({ nav: { dashboard: 'Panel ZZ' } }), 'utf8');

    assert.equal(i18n.tIn('zz', 'nav.dashboard'), 'Panel ZZ');
    assert.equal(i18n.tIn('zz', 'nav.settings'), 'Settings');
    assert.equal(i18n.tIn('zz', 'hic.olmayan.anahtar'), 'hic.olmayan.anahtar');
  });

  it('yer tutucuları doldurur, bilinmeyeni olduğu gibi bırakır', () => {
    i18n.setLocale('en');
    assert.equal(i18n.t('cat.files', { count: 12 }), '12 files');
    assert.equal(i18n.t('cat.files', {}), '{count} files');
    assert.equal(i18n.interpolate('a {x} b {y}', { x: 1 }), 'a 1 b {y}');
  });

  it('yayınlanan her dil bütün anahtarları ve aynı yer tutucuları taşır', () => {
    const base = i18n.loadCatalog('en');
    const keys = Object.keys(base);
    const locales = i18n.availableLocales().filter((meta) => meta.code !== 'en');
    assert.ok(locales.length >= 4, 'en az dört çeviri bekleniyordu');

    for (const meta of locales) {
      const dict = i18n.loadCatalog(meta.code);
      const missing = keys.filter((key) => !(key in dict));
      assert.deepEqual(missing, [], `${meta.code} eksik anahtar taşıyor`);
      for (const key of keys) {
        const want = (String(base[key]).match(/\{\w+\}/g) || []).sort().join(',');
        const got = (String(dict[key]).match(/\{\w+\}/g) || []).sort().join(',');
        assert.equal(got, want, `${meta.code}:${key} yer tutucuları uyuşmuyor`);
        assert.ok(String(dict[key]).trim(), `${meta.code}:${key} boş`);
      }
    }
  });

  it('paket İngilizce üzerine seçili dili bindirir', () => {
    const bundle = i18n.bundle('tr');
    assert.equal(bundle.locale, 'tr');
    assert.equal(bundle.fallback, 'en');
    assert.equal(bundle.dict['nav.dashboard'], 'Panel');
    // İngilizce'de olup seçili dilde olmayan anahtar da pakette bulunur.
    assert.equal(Object.keys(bundle.dict).length, Object.keys(i18n.loadCatalog('en')).length);
  });

  it('sayı ve boyut biçimlerini dile uyarlar', () => {
    assert.equal(i18n.number(1234567, 'en'), '1,234,567');
    assert.equal(i18n.number(1234567, 'tr'), '1.234.567');
    assert.equal(i18n.humanSize(1536, 'en'), '1.5 KB');
    assert.equal(i18n.humanSize(1536, 'tr'), '1,5 KB');
  });

  it('sağdan sola dilleri işaretler', () => {
    assert.equal(i18n.isRtl('ar'), true);
    assert.equal(i18n.isRtl('fa'), true);
    assert.equal(i18n.isRtl('tr'), false);
  });
});
