'use strict';

/**
 * Temizleyici.
 *
 * İki mod vardır:
 *
 *   quarantine (varsayılan) — dosyalar <data>/quarantine/<oturum>/ altına
 *     taşınır, manifest ile birlikte saklanır ve istenirse geri yüklenebilir.
 *   delete — dosyalar doğrudan silinir. Geri alınamaz.
 *
 * Her dosya silinmeden önce güvenlik kapısından geçer: yalnızca tarama
 * kategorilerinde tanımlı köklerin altındaki dosyalar silinebilir.
 */

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const ai = require('./ai');
const config = require('./config');
const store = require('./store');
const trash = require('./trash');
const {
  expandRoots,
  fmtDateTime,
  humanSize,
  isPathSafeToDelete,
  isUnder,
  itemId,
  moveFile,
  norm,
} = require('./utils');

const MAX_ERRORS = 40;
const MAX_REPORTED = 200;

function noop() {}

function newSessionId() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

// ------------------------------------------------------------------ kökler
/** Silme izni verilen kök klasörler (config'ten türetilir). */
async function allowedDeleteRoots() {
  const roots = [...config.EXTRA_DELETE_ROOTS];

  for (const cat of config.CATEGORIES) {
    if (cat.mode === 'walk') {
      roots.push(...(await expandRoots(cat.roots)));
    } else if (cat.mode === 'glob') {
      for (const pattern of cat.roots) {
        const parent = path.dirname(pattern);
        if (!parent.includes('*') && !parent.includes('?')) roots.push(parent);
      }
    }
  }

  const unique = [];
  const seen = new Set();
  for (const root of roots) {
    const key = norm(root);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(root);
  }
  return unique;
}

// ------------------------------------------------------------------ temizlik
/**
 * Seçilen kategorileri/dosyaları temizler.
 *
 * `scanResult` bellekteki tam tarama sonucudur (`_full` listelerini içerir).
 * `categoryIds` verilen kategorilerin tamamı, `itemIds` ise yalnızca o
 * kimliğe sahip dosyalar işlenir. Yollar arayüzden değil, buradan gelir.
 */
async function clean(options = {}) {
  const {
    scanResult,
    categoryIds = [],
    itemIds = [],
    mode: rawMode = 'quarantine',
    dryRun = false,
    onProgress = noop,
  } = options;

  if (!scanResult || !Array.isArray(scanResult.categories)) {
    return { ok: false, error: 'Önce tarama yapmalısınız' };
  }

  const mode = rawMode === 'delete' ? 'delete' : 'quarantine';
  const wantedItems = new Set(itemIds);
  const allowedRoots = await allowedDeleteRoots();
  const catMap = new Map(scanResult.categories.map((c) => [c.id, c]));

  const targets = [];
  let recycleNeeded = false;

  for (const catId of categoryIds) {
    const cat = catMap.get(catId);
    if (!cat) continue;
    if (catId === 'recycle_bin') {
      recycleNeeded = true;
      continue;
    }
    for (const row of cat._full || []) {
      targets.push({ path: row.path, size: row.size, category: catId });
    }
  }

  if (wantedItems.size) {
    for (const [catId, cat] of catMap) {
      if (catId === 'recycle_bin') {
        if ((cat.items || []).some((i) => wantedItems.has(i.id))) recycleNeeded = true;
        continue;
      }
      for (const row of cat._full || []) {
        if (wantedItems.has(itemId(row.path))) {
          targets.push({ path: row.path, size: row.size, category: catId });
        }
      }
    }
  }

  // Aynı dosya iki kategoride birden görünebilir (ör. büyük + eski indirilenler).
  const deduped = new Map();
  for (const target of targets) deduped.set(norm(target.path), target);
  const uniqueTargets = [...deduped.values()];

  const session = newSessionId();
  const quarantineDir = path.join(config.QUARANTINE_DIR, session);
  const manifest = { session, created: Date.now() / 1000, mode, dry_run: dryRun, entries: [] };

  const deleted = [];
  const errors = [];
  let totalBytes = 0;
  const total = uniqueTargets.length;

  for (let index = 0; index < uniqueTargets.length; index += 1) {
    const target = uniqueTargets[index];
    if (total) {
      onProgress({
        percent: Math.round((index / total) * 96),
        stage: `${path.basename(target.path).slice(0, 40)} işleniyor…`,
      });
    }

    const [allowed, reason] = isPathSafeToDelete(target.path, allowedRoots);
    if (!allowed) {
      if (errors.length < MAX_ERRORS) errors.push({ path: target.path, error: reason });
      continue;
    }

    let stat;
    try {
      stat = await fsp.stat(target.path);
      if (!stat.isFile()) continue;
    } catch {
      continue; // bu arada silinmiş olabilir
    }

    const size = stat.size || target.size || 0;

    if (dryRun) {
      totalBytes += size;
      deleted.push({ path: target.path, size, category: target.category, action: 'dry-run' });
      continue;
    }

    try {
      if (mode === 'quarantine') {
        const stored = await quarantineMove(target.path, quarantineDir);
        manifest.entries.push({
          original: target.path,
          stored,
          size,
          category: target.category,
          at: Date.now() / 1000,
        });
      } else {
        await fsp.unlink(target.path);
      }
    } catch (err) {
      if (errors.length < MAX_ERRORS) {
        errors.push({ path: target.path, error: (err && err.message) || String(err) });
      }
      continue;
    }

    totalBytes += size;
    deleted.push({ path: target.path, size, category: target.category, action: mode });
  }

  // ---------------------------------------------------------- geri dönüşüm
  let recycleReport = null;
  if (recycleNeeded) {
    onProgress({ percent: 97, stage: 'Geri dönüşüm kutusu boşaltılıyor…' });
    const before = await trash.stats({ refresh: true });

    if (dryRun) {
      recycleReport = { dry_run: true, planned: before.size || 0 };
      totalBytes += before.size || 0;
    } else {
      const result = await trash.empty();
      recycleReport = { ok: result.ok, error: result.error || '', freed: before.size || 0 };
      if (result.ok) {
        totalBytes += before.size || 0;
        deleted.push({
          path: 'Geri Dönüşüm Kutusu',
          size: before.size || 0,
          category: 'recycle_bin',
          action: 'empty',
        });
      } else if (errors.length < MAX_ERRORS) {
        errors.push({ path: 'Geri Dönüşüm Kutusu', error: result.error || 'bilinmeyen hata' });
      }
    }
  }

  // ---------------------------------------------------------- manifest/geçmiş
  let restorable = false;
  if (mode === 'quarantine' && !dryRun && manifest.entries.length) {
    await fsp.mkdir(quarantineDir, { recursive: true });
    await store.writeJson(path.join(quarantineDir, 'manifest.json'), manifest);
    restorable = true;
  }

  const report = {
    ok: errors.length === 0 || deleted.length > 0,
    session,
    mode,
    dry_run: dryRun,
    category_ids: categoryIds,
    file_count: deleted.length,
    bytes: totalBytes,
    bytes_h: humanSize(totalBytes),
    errors,
    error_count: errors.length,
    recycle: recycleReport,
    restorable,
    deleted: deleted.slice(0, MAX_REPORTED),
    finished_at: Date.now() / 1000,
  };

  if (!dryRun) {
    await store.appendHistory({
      session,
      at: Date.now() / 1000,
      at_h: fmtDateTime(Date.now() / 1000),
      mode,
      categories: categoryIds,
      file_count: deleted.length,
      bytes: totalBytes,
      bytes_h: humanSize(totalBytes),
      error_count: errors.length,
      restorable,
    });
  }

  onProgress({ percent: 100, stage: 'Temizlik tamamlandı' });
  return report;
}

/** Dosyayı karantinaya taşır; ad çakışmasını önlemek için benzersizleştirir. */
async function quarantineMove(source, quarantineDir) {
  await fsp.mkdir(quarantineDir, { recursive: true });
  const name = path.basename(source) || 'dosya';
  const stamp = crypto.randomBytes(4).toString('hex');
  const target = path.join(quarantineDir, `${stamp}__${name}`);
  await moveFile(source, target);
  return path.basename(target);
}

// ------------------------------------------------------------------ karantina
async function listQuarantine() {
  const sessions = [];
  let entries;
  try {
    entries = await fsp.readdir(config.QUARANTINE_DIR, { withFileTypes: true });
  } catch {
    return sessions;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(config.QUARANTINE_DIR, entry.name);
    const manifestPath = path.join(dir, 'manifest.json');
    let manifest;
    try {
      manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
    } catch {
      continue;
    }
    const rows = Array.isArray(manifest.entries) ? manifest.entries : [];
    const size = rows.reduce((sum, row) => sum + (row.size || 0), 0);
    sessions.push({
      session: entry.name,
      created: manifest.created || 0,
      created_h: fmtDateTime(manifest.created || 0),
      mode: manifest.mode || 'quarantine',
      file_count: rows.length,
      size,
      size_h: humanSize(size),
      sample: rows.slice(0, 5).map((r) => path.basename(r.original || '')),
    });
  }

  sessions.sort((a, b) => b.created - a.created);
  return sessions;
}

/** Karantinadaki dosyaları özgün konumlarına geri taşır. */
async function restoreSession(session, { onProgress = noop } = {}) {
  if (!session || session.includes('..') || /[\\/]/.test(session)) {
    return { ok: false, error: 'Geçersiz oturum adı', restored: 0 };
  }
  const sessionDir = path.join(config.QUARANTINE_DIR, session);
  if (!isUnder(sessionDir, config.QUARANTINE_DIR)) {
    return { ok: false, error: 'Geçersiz oturum yolu', restored: 0 };
  }

  const manifestPath = path.join(sessionDir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  } catch {
    return { ok: false, error: 'Böyle bir karantina oturumu yok', restored: 0 };
  }

  const rows = Array.isArray(manifest.entries) ? manifest.entries : [];
  const failed = [];
  let restored = 0;
  let restoredBytes = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    onProgress({
      percent: Math.round((index / Math.max(rows.length, 1)) * 100),
      stage: 'Geri yükleniyor…',
    });

    const original = row.original || '';
    const stored = path.join(sessionDir, row.stored || '');
    if (!row.stored || !isUnder(stored, sessionDir)) {
      failed.push({ path: original, error: 'Geçersiz karantina kaydı' });
      continue;
    }

    try {
      await fsp.access(stored);
    } catch {
      failed.push({ path: original, error: 'Karantina dosyası bulunamadı' });
      continue;
    }

    try {
      await fsp.mkdir(path.dirname(original), { recursive: true });
      // Aynı yolda yeni bir dosya oluşmuşsa üzerine yazmak yerine yanına koy.
      let destination = original;
      try {
        await fsp.access(destination);
        const parsed = path.parse(original);
        destination = path.join(parsed.dir, `${parsed.name} (geri yüklendi)${parsed.ext}`);
      } catch {
        /* hedef boş, doğrudan yazılabilir */
      }
      await moveFile(stored, destination);
      restored += 1;
      restoredBytes += row.size || 0;
    } catch (err) {
      failed.push({ path: original, error: (err && err.message) || String(err) });
    }
  }

  if (!failed.length) {
    await fsp.rm(sessionDir, { recursive: true, force: true });
    onProgress({ percent: 100, stage: 'Geri yükleme tamamlandı' });
    return {
      ok: true,
      restored,
      size: restoredBytes,
      size_h: humanSize(restoredBytes),
      failed: [],
      session_removed: true,
    };
  }

  // Yalnızca başarısız kayıtlar kalsın; kısmi geri yükleme sonrası tutarlılık.
  const remaining = rows.filter((row) => failed.some((f) => f.path === row.original));
  manifest.entries = remaining;
  await store.writeJson(manifestPath, manifest);

  onProgress({ percent: 100, stage: 'Geri yükleme tamamlandı' });
  return {
    ok: true,
    restored,
    size: restoredBytes,
    size_h: humanSize(restoredBytes),
    failed: failed.slice(0, 20),
    session_removed: false,
  };
}

/** Karantina oturumunu kalıcı olarak siler. */
async function purgeSession(session) {
  if (!session || session.includes('..') || /[\\/]/.test(session)) {
    return { ok: false, error: 'Geçersiz oturum adı' };
  }
  const sessionDir = path.join(config.QUARANTINE_DIR, session);
  if (!isUnder(sessionDir, config.QUARANTINE_DIR)) {
    return { ok: false, error: 'Geçersiz oturum yolu' };
  }
  try {
    await fsp.access(sessionDir);
  } catch {
    return { ok: false, error: 'Oturum bulunamadı' };
  }
  await fsp.rm(sessionDir, { recursive: true, force: true });
  return { ok: true };
}

/** Karantinanın disk kullanımı. */
async function quarantineUsage() {
  const sessions = await listQuarantine();
  const size = sessions.reduce((sum, s) => sum + s.size, 0);
  const files = sessions.reduce((sum, s) => sum + s.file_count, 0);
  return { sessions: sessions.length, files, size, size_h: humanSize(size) };
}

/**
 * Temizlik öncesi önizleme: hangi dosyaların kaç bayt kazandıracağını
 * hiçbir şeye dokunmadan hesaplar.
 */
async function preview(scanResult, categoryIds, itemIds) {
  const report = await clean({ scanResult, categoryIds, itemIds, dryRun: true, mode: 'quarantine' });
  return {
    file_count: report.file_count,
    bytes: report.bytes,
    bytes_h: report.bytes_h,
    errors: report.errors,
    error_count: report.error_count,
  };
}

/** Seçimin güvenlik kapısından geçen/geçmeyen dosya sayısını raporlar. */
async function auditSelection(scanResult, categoryIds) {
  const allowedRoots = await allowedDeleteRoots();
  const catMap = new Map((scanResult.categories || []).map((c) => [c.id, c]));
  let allowed = 0;
  let blocked = 0;
  const reasons = new Map();

  for (const catId of categoryIds) {
    const cat = catMap.get(catId);
    if (!cat || catId === 'recycle_bin') continue;
    for (const row of cat._full || []) {
      const [ok, reason] = isPathSafeToDelete(row.path, allowedRoots);
      if (ok) allowed += 1;
      else {
        blocked += 1;
        reasons.set(reason, (reasons.get(reason) || 0) + 1);
      }
    }
  }

  return { allowed, blocked, reasons: [...reasons].map(([reason, count]) => ({ reason, count })) };
}

module.exports = {
  clean,
  preview,
  auditSelection,
  allowedDeleteRoots,
  listQuarantine,
  restoreSession,
  purgeSession,
  quarantineUsage,
  newSessionId,
};
