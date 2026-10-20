'use strict';

/**
 * Windows Geri Dönüşüm Kutusu köprüsü.
 *
 * Node'da yerel eklenti (native addon) derlemeye gerek kalmadan çalışsın diye
 * PowerShell üzerinden Shell COM nesnesi kullanılır. Soğuk başlatma maliyeti
 * yüksek olduğundan sonuç kısa süre önbelleğe alınır.
 */

const { execFile } = require('child_process');
const fsp = require('fs/promises');
const path = require('path');

const config = require('./config');
const i18n = require('../i18n');
const { humanSize } = require('./utils');

const IS_WINDOWS = process.platform === 'win32';
const STATS_TTL_MS = 15000;
const STATS_TIMEOUT_MS = 45000;
const EMPTY_TIMEOUT_MS = 180000;

let cache = { at: 0, value: null };

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

function runPowerShell(script, timeout) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [...PS_ARGS, script],
      { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stderr: String(stderr || '') }));
          return;
        }
        resolve(String(stdout || ''));
      }
    );
  });
}

const STATS_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$shell = New-Object -ComObject Shell.Application',
  '$bin = $shell.NameSpace(0xA)',
  'if ($null -eq $bin) { Write-Output "ERR|NameSpace yok"; exit 0 }',
  '$items = @($bin.Items())',
  '$total = [int64]0',
  'foreach ($item in $items) { try { $s = $item.Size; if ($s) { $total += [int64]$s } } catch { } }',
  'Write-Output ("OK|" + $total + "|" + $items.Count)',
].join('; ');

const EMPTY_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'Clear-RecycleBin -Force -ErrorAction Stop',
  'Write-Output "OK"',
].join('; ');

/** PowerShell erişilemediğinde $Recycle.Bin klasörünü doğrudan toplar. */
async function fallbackStats() {
  const root = path.join(config.SYSTEM_DRIVE, '$Recycle.Bin');
  let total = 0;
  let count = 0;
  let sids;
  try {
    sids = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return { ok: false, size: 0, count: 0, error: i18n.t('note.recycleUnreadable'), source: 'none' };
  }
  for (const sid of sids) {
    if (!sid.isDirectory()) continue;
    const stack = [path.join(root, sid.name)];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        try {
          const stat = await fsp.stat(full);
          total += stat.size;
          count += 1;
        } catch {
          /* kilitli dosya atlanır */
        }
      }
    }
  }
  return {
    ok: true,
    size: total,
    count,
    size_h: humanSize(total),
    error: '',
    source: 'filesystem',
  };
}

/**
 * Geri dönüşüm kutusunun boyutu ve öğe sayısı.
 * @returns {Promise<{ok: boolean, size: number, count: number, size_h: string, error: string, source: string}>}
 */
async function stats({ refresh = false } = {}) {
  if (!refresh && cache.value && Date.now() - cache.at < STATS_TTL_MS) {
    return cache.value;
  }

  let value;
  if (!IS_WINDOWS) {
    value = { ok: false, size: 0, count: 0, size_h: humanSize(0), error: 'Yalnızca Windows', source: 'none' };
  } else {
    try {
      const out = await runPowerShell(STATS_SCRIPT, STATS_TIMEOUT_MS);
      const line = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith('OK|') || l.startsWith('ERR|'));
      if (line && line.startsWith('OK|')) {
        const [, rawSize, rawCount] = line.split('|');
        const size = Number(rawSize) || 0;
        value = {
          ok: true,
          size,
          count: Number(rawCount) || 0,
          size_h: humanSize(size),
          error: '',
          source: 'shell',
        };
      } else {
        value = await fallbackStats();
      }
    } catch {
      value = await fallbackStats();
    }
  }

  cache = { at: Date.now(), value };
  return value;
}

/**
 * Geri dönüşüm kutusunu boşaltır.
 * @returns {Promise<{ok: boolean, error: string}>}
 */
async function empty() {
  if (!IS_WINDOWS) {
    return { ok: false, error: 'Yalnızca Windows' };
  }
  try {
    const out = await runPowerShell(EMPTY_SCRIPT, EMPTY_TIMEOUT_MS);
    if (/OK/.test(out)) {
      cache = { at: 0, value: null };
      return { ok: true, error: '' };
    }
    return { ok: false, error: out.trim() || i18n.t('err.unknown') };
  } catch (err) {
    const text = String((err && err.stderr) || (err && err.message) || err);
    if (/empty/i.test(text)) {
      cache = { at: 0, value: null };
      return { ok: true, error: '' };
    }
    return { ok: false, error: `Yönetici izni gerekebilir (${text.split(/\r?\n/)[0].slice(0, 160)})` };
  }
}

function invalidate() {
  cache = { at: 0, value: null };
}

module.exports = { stats, empty, invalidate, IS_WINDOWS };
