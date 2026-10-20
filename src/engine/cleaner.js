'use strict';

/**
 * Temizleyici.
 *
 * There are two modes:
 *
 *   quarantine (default) — files are moved under <data>/quarantine/<session>/,
 *     stored with a manifest, and can be restored on request.
 *   delete — files are removed directly. This cannot be undone.
 *
 * Every file passes the security gate before deletion: only files beneath the
 * roots defined by the scan categories can be deleted.
 */

const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const ai = require('./ai');
const config = require('./config');
const store = require('./store');
const trash = require('./trash');
const i18n = require('../i18n');
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

// ------------------------------------------------------------------ roots
/** Root folders allowed for deletion (derived from config). */
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

// ------------------------------------------------------------------ cleaning
/**
 * Cleans the selected categories/files.
 *
 * `scanResult` is the full in-memory scan result (it contains the `_full` lists).
 * Every category in `categoryIds` is processed; `itemIds` narrows that to the
 * files with those identifiers. Paths come from here, not from the interface.
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
    return { ok: false, error: i18n.t('err.noScan') };
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

  // The same file can appear in two categories (large + old downloads, for example).
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
        stage: i18n.t('progress.processing', { name: path.basename(target.path).slice(0, 40) }),
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
        continue; // it may have been deleted in the meantime
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

  // ---------------------------------------------------------- recycle bin
  let recycleReport = null;
  if (recycleNeeded) {
    onProgress({ percent: 97, stage: i18n.t('progress.recycle') });
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
          path: i18n.t('cat.recycle_bin.name'),
          size: before.size || 0,
          category: 'recycle_bin',
          action: 'empty',
        });
      } else if (errors.length < MAX_ERRORS) {
        errors.push({
          path: i18n.t('cat.recycle_bin.name'),
          error: result.error || i18n.t('err.unknown'),
        });
      }
    }
  }

  // ---------------------------------------------------------- manifest/history
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

  onProgress({ percent: 100, stage: i18n.t('progress.cleanDone') });
  return report;
}

/** Moves the file to quarantine, making the name unique to avoid collisions. */
async function quarantineMove(source, quarantineDir) {
  await fsp.mkdir(quarantineDir, { recursive: true });
  const name = path.basename(source) || i18n.t('common.file');
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

/** Moves quarantined files back to their original locations. */
async function restoreSession(session, { onProgress = noop } = {}) {
  if (!session || session.includes('..') || /[\\/]/.test(session)) {
    return { ok: false, error: i18n.t('err.invalidSession'), restored: 0 };
  }
  const sessionDir = path.join(config.QUARANTINE_DIR, session);
  if (!isUnder(sessionDir, config.QUARANTINE_DIR)) {
    return { ok: false, error: i18n.t('err.invalidSessionPath'), restored: 0 };
  }

  const manifestPath = path.join(sessionDir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  } catch {
    return { ok: false, error: i18n.t('err.sessionMissing'), restored: 0 };
  }

  const rows = Array.isArray(manifest.entries) ? manifest.entries : [];
  const failed = [];
  let restored = 0;
  let restoredBytes = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    onProgress({
      percent: Math.round((index / Math.max(rows.length, 1)) * 100),
      stage: i18n.t('progress.restoring'),
    });

    const original = row.original || '';
    const stored = path.join(sessionDir, row.stored || '');
    if (!row.stored || !isUnder(stored, sessionDir)) {
      failed.push({ path: original, error: i18n.t('err.invalidRow') });
      continue;
    }

    try {
      await fsp.access(stored);
    } catch {
      failed.push({ path: original, error: i18n.t('err.quarantineFileMissing') });
      continue;
    }

    try {
      await fsp.mkdir(path.dirname(original), { recursive: true });
      // If a new file now exists at the same path, place it beside it instead of overwriting.
      let destination = original;
      try {
        await fsp.access(destination);
        const parsed = path.parse(original);
        destination = path.join(parsed.dir, `${parsed.name} (restored)${parsed.ext}`);
      } catch {
        /* the target is free, it can be written directly */
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
    onProgress({ percent: 100, stage: i18n.t('progress.restoreDone') });
    return {
      ok: true,
      restored,
      size: restoredBytes,
      size_h: humanSize(restoredBytes),
      failed: [],
      session_removed: true,
    };
  }

  // Keep only the failed records; keeps the manifest consistent after a partial restore.
  const remaining = rows.filter((row) => failed.some((f) => f.path === row.original));
  manifest.entries = remaining;
  await store.writeJson(manifestPath, manifest);

  onProgress({ percent: 100, stage: i18n.t('progress.restoreDone') });
  return {
    ok: true,
    restored,
    size: restoredBytes,
    size_h: humanSize(restoredBytes),
    failed: failed.slice(0, 20),
    session_removed: false,
  };
}

/** Permanently deletes a quarantine session. */
async function purgeSession(session) {
  if (!session || session.includes('..') || /[\\/]/.test(session)) {
    return { ok: false, error: i18n.t('err.invalidSession') };
  }
  const sessionDir = path.join(config.QUARANTINE_DIR, session);
  if (!isUnder(sessionDir, config.QUARANTINE_DIR)) {
    return { ok: false, error: i18n.t('err.invalidSessionPath') };
  }
  try {
    await fsp.access(sessionDir);
  } catch {
    return { ok: false, error: i18n.t('err.sessionNotFound') };
  }
  await fsp.rm(sessionDir, { recursive: true, force: true });
  return { ok: true };
}

/** Disk usage of the quarantine. */
async function quarantineUsage() {
  const sessions = await listQuarantine();
  const size = sessions.reduce((sum, s) => sum + s.size, 0);
  const files = sessions.reduce((sum, s) => sum + s.file_count, 0);
  return { sessions: sessions.length, files, size, size_h: humanSize(size) };
}

/**
 * Pre-clean preview: calculates how many bytes each file would free up
 * without touching anything.
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

/** Reports how many selected files pass or fail the security gate. */
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
