'use strict';

/**
 * Small helpers: size formatting, safe directory walking, path security.
 * All I/O is asynchronous, so the interface never freezes.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const config = require('./config');
const i18n = require('../i18n');

const HOUR = 3600;
const DAY = 86400;

// ------------------------------------------------------------------ format
/** 1536 -> '1.5 KB' (the decimal separator follows the language: 1,5 KB) */
function humanSize(num) {
  return i18n.humanSize(num);
}

// ------------------------------------------------------------------ yollar
/** Normalised absolute path for comparison (case-insensitive on Windows). */
function norm(p) {
  try {
    return path.resolve(String(p)).toLowerCase();
  } catch {
    return String(p).toLowerCase();
  }
}

/** Is `child` under the `root` folder (or the root itself)? */
function isUnder(child, root) {
  const c = norm(child);
  const r = norm(root).replace(/[\\/]+$/, '');
  return c === r || c.startsWith(r + path.sep) || c.startsWith(r + '/');
}

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(text) {
  return text.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function wildcardToRegExp(pattern) {
  const source = escapeRegExp(pattern).replace(/\*/g, '[^\\\\/]*').replace(/\?/g, '[^\\\\/]');
  return new RegExp(`^${source}$`, 'i');
}

/**
 * Expands chains such as `a\*\b\*.log` step by step into real paths.
 * The Python version only supported a wildcard in the last segment; here a
 * wildcard in the middle (Chrome profiles, for example) resolves correctly too.
 */
async function expandChain(pattern) {
  const parsed = path.parse(pattern);
  const root = parsed.root || path.parse(process.cwd()).root;
  const rest = pattern
    .slice(root.length)
    .split(/[\\/]+/)
    .filter(Boolean);

  let current = [root];
  for (const segment of rest) {
    const wildcard = segment.includes('*') || segment.includes('?');
    const next = [];
    for (const base of current) {
      if (wildcard) {
        let names = [];
        try {
          names = await fsp.readdir(base);
        } catch {
          continue;
        }
        const re = wildcardToRegExp(segment);
        for (const name of names) {
          if (re.test(name)) next.push(path.join(base, name));
        }
      } else {
        const candidate = path.join(base, segment);
        if (await pathExists(candidate)) next.push(candidate);
      }
    }
    current = next;
    if (!current.length) return [];
  }
  return current;
}

/** Expands wildcard path patterns into real folder paths and drops duplicates. */
async function expandRoots(patterns) {
  const found = [];
  const seen = new Set();
  for (const pattern of patterns) {
    let matches = [];
    if (pattern.includes('*') || pattern.includes('?')) {
      matches = await expandChain(pattern);
    } else if (await pathExists(pattern)) {
      matches = [pattern];
    }
    for (const match of matches) {
      const key = norm(match);
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(match);
    }
  }
  return found;
}

// ------------------------------------------------------------------ gezme
/**
 * Yields the files under the root as {path, size, mtime}.
 *
 * Locked or unreachable directories are skipped silently and symbolic links
 * are not followed (guards against infinite loops and wrong deletions).
 */
async function* walkFiles(root, options = {}) {
  const maxDepth = options.maxDepth ?? config.MAX_WALK_DEPTH;
  const minAgeDays = options.minAgeDays ?? null;
  const nowMs = options.nowMs ?? Date.now();
  const limit = options.limit ?? 200000;
  const exclude = options.skipRoots || null;
  const extraSkip = new Set((options.extraSkipDirs || []).map((s) => s.toLowerCase()));

  let count = 0;
  const stack = [{ dir: root, depth: 0 }];

  while (stack.length) {
    const { dir, depth } = stack.pop();

    if (exclude && exclude.some((ex) => norm(dir) === norm(ex))) continue;

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;

      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        const name = entry.name.toLowerCase();
        if (config.SKIP_DIR_NAMES.includes(name) || extraSkip.has(name)) continue;
        if (depth + 1 < maxDepth) stack.push({ dir: full, depth: depth + 1 });
        continue;
      }

      if (!entry.isFile()) continue;

      let stat;
      try {
        stat = await fsp.stat(full);
      } catch {
        continue;
      }

      if (minAgeDays != null) {
        const ageDays = (nowMs - stat.mtimeMs) / 1000 / DAY;
        if (ageDays < minAgeDays) continue;
      }

      yield { path: full, size: stat.size, mtime: Math.floor(stat.mtimeMs / 1000) };

      count += 1;
      if (count >= limit) return;
    }
  }
}

/** Yields single-file patterns that may contain `*`. */
async function* globFiles(patterns) {
  for (const pattern of patterns) {
    const matches = await expandChain(pattern);
    for (const match of matches) {
      try {
        const stat = await fsp.stat(match);
        if (!stat.isFile()) continue;
        yield { path: match, size: stat.size, mtime: Math.floor(stat.mtimeMs / 1000) };
      } catch {
        continue;
      }
    }
  }
}

// ------------------------------------------------------------------ kimlik
/** Stable identifier for a path (12 characters). */
function itemId(target) {
  return crypto.createHash('md5').update(norm(target), 'utf8').digest('hex').slice(0, 12);
}

/** Fast content fingerprint from the first 128 KB plus the size. */
async function partialHash(target, chunk = 131072) {
  const hash = crypto.createHash('sha1');
  let handle;
  try {
    handle = await fsp.open(target, 'r');
    const buffer = Buffer.alloc(chunk);
    const { bytesRead } = await handle.read(buffer, 0, chunk, 0);
    hash.update(buffer.subarray(0, bytesRead));
  } catch {
    return '';
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
  try {
    const stat = await fsp.stat(target);
    hash.update(String(stat.size));
  } catch {
    /* ignored */
  }
  return hash.digest('hex');
}

// ------------------------------------------------------------------ security
/**
 * Deletion security gate.
 * @returns {[boolean, string]} [allowed, reason]
 */
function isPathSafeToDelete(target, allowedRoots) {
  let abs;
  try {
    abs = path.resolve(String(target));
  } catch {
    return [false, i18n.t('guard.invalidPath')];
  }
  const low = abs.toLowerCase();

  for (const fragment of config.DENY_FRAGMENTS) {
    if (low.includes(fragment)) {
      return [
        false,
        i18n.t('guard.component', { fragment: fragment.replace(/\\/g, '') }),
      ];
    }
  }

  if (!allowedRoots.some((root) => isUnder(abs, root))) {
    return [false, i18n.t('guard.outside')];
  }

  if (norm(abs) === norm(config.SYSTEM_DRIVE) || norm(abs) === norm(config.USER_HOME)) {
    return [false, i18n.t('guard.root')];
  }

  for (const dir of config.PROTECTED_USER_DIRS) {
    if (norm(abs) === norm(path.join(config.USER_HOME, dir))) {
      return [false, i18n.t('guard.folder', { dir })];
    }
  }

  return [true, 'ok'];
}

// ------------------------------------------------------------------ zaman
function ageDays(mtime, nowMs = Date.now()) {
  return Math.max(0, Math.floor((nowMs - mtime * 1000) / 1000 / DAY));
}

function fmtDate(mtime) {
  return i18n.formatDate(mtime);
}

function fmtDateTime(mtime) {
  return i18n.formatDateTime(mtime);
}

/** 1234567 -> '1,234,567' (en) · '1.234.567' (tr) */
function fmtNumber(value) {
  return i18n.number(value);
}

// ------------------------------------------------------------------ moving
/** A move that also works across different drives. */
async function moveFile(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  try {
    await fsp.rename(from, to);
    return;
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      await fsp.copyFile(from, to);
      await fsp.unlink(from);
      return;
    }
    throw err;
  }
}

/** Disk doluluk bilgisi (Node 18.15+ fs.statfs). */
async function diskUsage(drive) {
  try {
    const stats = await fsp.statfs(drive);
    const total = Number(stats.blocks) * Number(stats.bsize);
    const free = Number(stats.bavail) * Number(stats.bsize);
    const used = total - free;
    if (!total) return null;
    return {
      drive,
      total,
      used,
      free,
      percent: Math.round((used / total) * 1000) / 10,
      total_h: humanSize(total),
      used_h: humanSize(used),
      free_h: humanSize(free),
    };
  } catch {
    return null;
  }
}

module.exports = {
  HOUR,
  DAY,
  humanSize,
  fmtNumber,
  norm,
  isUnder,
  pathExists,
  expandRoots,
  expandChain,
  walkFiles,
  globFiles,
  itemId,
  partialHash,
  isPathSafeToDelete,
  ageDays,
  fmtDate,
  fmtDateTime,
  moveFile,
  diskUsage,
  fs,
  fsp,
};
