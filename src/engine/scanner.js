'use strict';

/**
 * Tarama motoru.
 *
 * Kategorileri dolaşıp dosya envanteri çıkarır. Sonuç iki katmanlıdır:
 *
 *   items  – arayüze gönderilen, en büyük N dosya (gösterim için)
 *   _full  – aynı kategorinin tam yol listesi (temizleyici için, bellekte kalır)
 *
 * `_full` listeleri hiçbir zaman arayüze gönderilmez; temizleyici seçimi
 * kategori/kimlik üzerinden alır, yol üzerinden almaz.
 */

const path = require('path');

const config = require('./config');
const trash = require('./trash');
const {
  ageDays,
  diskUsage,
  expandRoots,
  fmtDate,
  globFiles,
  humanSize,
  itemId,
  norm,
  partialHash,
  walkFiles,
} = require('./utils');

const DRIVE_LETTERS = ['D', 'E', 'F', 'G', 'H'];
const DUPLICATE_MAX_DEPTH = 5;
const HASH_CONCURRENCY = 8;

function noop() {}

function yieldToLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Sınırlı eşzamanlılıkla eşleme (kopya parmak izi hesabı için). */
async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

// ------------------------------------------------------------------ disk
async function diskInfo() {
  const candidates = [config.SYSTEM_DRIVE, ...DRIVE_LETTERS.map((l) => `${l}:\\`)];
  const drives = [];
  for (const drive of candidates) {
    const usage = await diskUsage(drive);
    if (usage) drives.push(usage);
  }
  const primary = drives[0] || {
    drive: config.SYSTEM_DRIVE,
    total: 0,
    used: 0,
    free: 0,
    percent: 0,
    total_h: '-',
    used_h: '-',
    free_h: '-',
  };
  return { primary, drives };
}

// ------------------------------------------------------------------ iskelet
function emptyCategory(cat, note = '') {
  return {
    id: cat.id,
    name: cat.name,
    icon: cat.icon,
    risk: cat.risk,
    description: cat.description,
    size: 0,
    size_h: humanSize(0),
    file_count: 0,
    items: [],
    items_truncated: 0,
    note,
    _full: [],
  };
}

function makeItem(target, size, mtime, cat, nowMs, extra = {}) {
  return {
    id: itemId(target),
    path: target,
    name: path.basename(target.replace(/[\\/]+$/, '')) || target,
    size: Math.trunc(size),
    size_h: humanSize(size),
    modified: mtime,
    modified_h: fmtDate(mtime),
    age_days: ageDays(mtime, nowMs),
    category: cat.id,
    risk: cat.risk,
    ...extra,
  };
}

function finalize(cat, items, full) {
  const totalSize = full.reduce((sum, row) => sum + row.size, 0);
  const sorted = [...items].sort((a, b) => b.size - a.size);
  return {
    id: cat.id,
    name: cat.name,
    icon: cat.icon,
    risk: cat.risk,
    description: cat.description,
    size: totalSize,
    size_h: humanSize(totalSize),
    file_count: full.length,
    items: sorted.slice(0, config.MAX_ITEMS_PER_CATEGORY),
    items_truncated: Math.max(0, sorted.length - config.MAX_ITEMS_PER_CATEGORY),
    note: '',
    _full: full,
  };
}

// ------------------------------------------------------------------ tarama
async function scan({ deep = false, onProgress = noop } = {}) {
  config.ensureDirs();
  const startedMs = Date.now();
  const started = startedMs / 1000;
  const total = config.CATEGORIES.length;
  const categories = [];

  for (let index = 0; index < config.CATEGORIES.length; index += 1) {
    const cat = config.CATEGORIES[index];
    onProgress({
      percent: Math.round((index / Math.max(total, 1)) * 92),
      stage: `${cat.name} taranıyor…`,
      category: cat.id,
    });

    if (cat.deep_only && !deep) {
      categories.push(emptyCategory(cat, 'Derin tarama açık değil'));
      continue;
    }

    try {
      categories.push(await scanCategory(cat, startedMs, deep));
    } catch (err) {
      categories.push(emptyCategory(cat, `Taranamadı: ${err && err.message ? err.message : err}`));
    }

    await yieldToLoop();
  }

  onProgress({ percent: 94, stage: 'Disk bilgisi okunuyor…', category: '' });
  const disk = await diskInfo();

  const totals = { all: 0, file_count: 0, safe: 0, caution: 0, risky: 0 };
  for (const cat of categories) {
    totals.all += cat.size;
    totals.file_count += cat.file_count;
    totals[cat.risk] = (totals[cat.risk] || 0) + cat.size;
  }

  const finishedMs = Date.now();
  onProgress({ percent: 100, stage: 'Tarama tamamlandı', category: '' });

  return {
    started_at: started,
    finished_at: finishedMs / 1000,
    duration: Math.round((finishedMs - startedMs) / 100) / 10,
    deep: Boolean(deep),
    categories,
    disk,
    totals: {
      all: totals.all,
      all_h: humanSize(totals.all),
      safe: totals.safe,
      safe_h: humanSize(totals.safe),
      caution: totals.caution,
      caution_h: humanSize(totals.caution),
      risky: totals.risky,
      risky_h: humanSize(totals.risky),
      file_count: totals.file_count,
    },
  };
}

async function scanCategory(cat, nowMs, deep) {
  if (cat.mode === 'walk') return scanWalk(cat, nowMs);
  if (cat.mode === 'glob') return scanGlob(cat, nowMs);
  if (cat.id === 'recycle_bin') return scanRecycle(cat, nowMs);
  if (cat.id === 'large_files') return scanLarge(cat, nowMs);
  if (cat.id === 'duplicates') return scanDuplicates(cat, nowMs);
  return emptyCategory(cat, 'Bilinmeyen tarama modu');
}

async function scanWalk(cat, nowMs) {
  const roots = await expandRoots(cat.roots);
  if (!roots.length) {
    return emptyCategory(cat, 'Bu bilgisayarda bulunamadı');
  }

  const full = [];
  const items = [];
  const seen = new Set();

  for (const root of roots) {
    for await (const file of walkFiles(root, { minAgeDays: cat.min_age_days, nowMs })) {
      const key = norm(file.path);
      if (seen.has(key)) continue;
      seen.add(key);
      full.push({ path: file.path, size: file.size });
      items.push(makeItem(file.path, file.size, file.mtime, cat, nowMs));
    }
  }

  if (!full.length) return emptyCategory(cat, 'Bu bilgisayarda bulunamadı');
  return finalize(cat, items, full);
}

async function scanGlob(cat, nowMs) {
  const items = [];
  for await (const file of globFiles(cat.roots)) {
    items.push(makeItem(file.path, file.size, file.mtime, cat, nowMs));
  }
  if (!items.length) return emptyCategory(cat, 'Bu bilgisayarda bulunamadı');
  return finalize(
    cat,
    items,
    items.map((i) => ({ path: i.path, size: i.size }))
  );
}

async function scanRecycle(cat, nowMs) {
  const info = await trash.stats();
  if (!info.ok) {
    return emptyCategory(cat, info.error || 'Geri dönüşüm kutusu okunamadı');
  }
  if (!info.count) {
    return emptyCategory(cat, 'Geri dönüşüm kutusu boş');
  }
  const item = {
    id: 'recycle_bin:all',
    path: 'Geri Dönüşüm Kutusu',
    name: `${info.count} öğe`,
    size: info.size,
    size_h: humanSize(info.size),
    modified: nowMs / 1000,
    modified_h: '-',
    age_days: 0,
    category: cat.id,
    risk: cat.risk,
    special: 'recycle_bin',
    note: 'Boşaltıldığında dosyalar kurtarılamaz',
  };
  return {
    id: cat.id,
    name: cat.name,
    icon: cat.icon,
    risk: cat.risk,
    description: cat.description,
    size: info.size,
    size_h: humanSize(info.size),
    file_count: info.count,
    items: [item],
    items_truncated: 0,
    note: '',
    _full: [],
  };
}

async function scanLarge(cat, nowMs) {
  const candidates = [];
  // AppData/Windows gibi klasörler walkFiles içinde atlanır: gürültü ve
  // yavaşlık önlenir, zaten diğer kategoriler oraları kapsıyor.
  for await (const file of walkFiles(config.USER_HOME, { maxDepth: config.MAX_WALK_DEPTH, limit: 250000 })) {
    if (file.size >= config.LARGE_FILE_BYTES) candidates.push(file);
  }
  if (!candidates.length) {
    return emptyCategory(cat, `${humanSize(config.LARGE_FILE_BYTES)} üzerinde dosya yok`);
  }
  candidates.sort((a, b) => b.size - a.size);
  const full = candidates.map((f) => ({ path: f.path, size: f.size }));
  const items = candidates.map((f) => makeItem(f.path, f.size, f.mtime, cat, nowMs));
  return finalize(cat, items, full);
}

async function scanDuplicates(cat, nowMs) {
  const bySize = new Map();
  for (const root of config.DUPLICATE_ROOTS) {
    for await (const file of walkFiles(root, { maxDepth: DUPLICATE_MAX_DEPTH, limit: config.DUP_MAX_FILES })) {
      if (file.size < config.DUP_MIN_BYTES) continue;
      if (!bySize.has(file.size)) bySize.set(file.size, []);
      bySize.get(file.size).push(file);
    }
  }

  // Önce boyut eşleşmesi (ucuz), sonra ilk 128 KB parmak izi (pahalı).
  const candidates = [];
  for (const [, entries] of bySize) {
    if (entries.length >= 2) candidates.push(...entries);
  }
  if (!candidates.length) {
    return emptyCategory(cat, 'Kopya dosya bulunamadı');
  }

  const hashes = await mapPool(candidates, HASH_CONCURRENCY, async (file) => {
    const digest = await partialHash(file.path);
    return digest ? `${file.size}:${digest}` : '';
  });

  const groups = new Map();
  for (let i = 0; i < candidates.length; i += 1) {
    const key = hashes[i];
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidates[i]);
  }

  const items = [];
  let savings = 0;
  let duplicateGroups = 0;

  for (const [, entries] of groups) {
    if (entries.length < 2) continue;
    duplicateGroups += 1;
    entries.sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
    const keeper = entries[0].path;
    for (const file of entries.slice(1)) {
      savings += file.size;
      items.push(
        makeItem(file.path, file.size, file.mtime, cat, nowMs, {
          duplicate_of: keeper,
          group_size: entries.length,
          detail: `${entries.length} kopyadan biri · aslı: ${keeper}`,
        })
      );
    }
  }

  if (!items.length) return emptyCategory(cat, 'Kopya dosya bulunamadı');

  items.sort((a, b) => b.size - a.size);
  const result = finalize(
    cat,
    items,
    items.map((i) => ({ path: i.path, size: i.size }))
  );
  result.note = `${duplicateGroups} kopya grubu · her gruptan yalnızca aslı korunur`;
  result.savings = savings;
  return result;
}

// ------------------------------------------------------------------ görünüm
/** Bellekteki tam sonucu arayüze gönderilecek hale getirir (`_full` çıkarılır). */
function publicView(result) {
  const { categories, ...rest } = result;
  return {
    ...rest,
    categories: categories.map(({ _full, ...cat }) => cat),
  };
}

/** Kategorileri yalnızca kimlikle eşleştirmek için hafif dizin. */
function indexCategories(result) {
  const map = new Map();
  for (const cat of result.categories || []) map.set(cat.id, cat);
  return map;
}

module.exports = {
  scan,
  diskInfo,
  publicView,
  indexCategories,
  scanCategory,
  emptyCategory,
  makeItem,
  finalize,
};
