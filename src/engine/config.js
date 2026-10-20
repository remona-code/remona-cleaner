'use strict';

/**
 * Application configuration, scanned locations and security boundaries.
 *
 * This file is the single source of truth: which paths may be scanned and
 * deleted is defined here. The scanner and the cleaner only work beneath the
 * roots defined here.
 *
 * Category names and descriptions are not kept here: the text comes from the
 * catalogues under `src/i18n` (`cat.<id>.name` / `cat.<id>.desc`), so a scan
 * result is produced in the same language as the interface.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const i18n = require('../i18n');

// ------------------------------------------------------------------ yollar
const SRC_DIR = path.resolve(__dirname, '..');
const ROOT_DIR = path.resolve(SRC_DIR, '..');

// The Electron main process overrides this with app.getPath('userData'); tests
// and command-line use keep the project-local data/ folder.
const DATA_DIR = process.env.AICLEANER_DATA_DIR || path.join(ROOT_DIR, 'data');
const QUARANTINE_DIR = path.join(DATA_DIR, 'quarantine');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const LAST_SCAN_FILE = path.join(DATA_DIR, 'last_scan.json');

// ------------------------------------------------------------------ sistem
const USER_HOME = os.homedir();
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(USER_HOME, 'AppData', 'Local');
const APPDATA = process.env.APPDATA || path.join(USER_HOME, 'AppData', 'Roaming');
const PROGRAMDATA = process.env.ProgramData || 'C:\\ProgramData';
const WINDIR = process.env.SystemRoot || 'C:\\Windows';
const TEMP = process.env.TEMP || path.join(LOCALAPPDATA, 'Temp');
const SYSTEM_DRIVE = (process.env.SystemDrive || 'C:') + '\\';

// ------------------------------------------------------------------ AI
// Provider choice and OpenAI details are managed from the Settings screen
// (settings.json). The environment variables below are seed values only:
// a value present in the settings file wins.
const OLLAMA_URL = process.env.AICLEANER_OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.AICLEANER_OLLAMA_MODEL || '';

const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1';
const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';
const OPENAI_BASE = process.env.AICLEANER_OPENAI_BASE || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.AICLEANER_OPENAI_MODEL || '';

const AI_TIMEOUT_MS = Number(process.env.AICLEANER_AI_TIMEOUT || 30) * 1000;
const AI_TEST_TIMEOUT_MS = 20000;
const AI_MODELS_TIMEOUT_MS = 15000;

/** Providers offered on the Settings screen. */
const AI_PROVIDERS = ['auto', 'openai', 'ollama', 'rules'];

// ------------------------------------------------------------------ scanning
const MAX_WALK_DEPTH = 6;
const MAX_ITEMS_PER_CATEGORY = 400; // largest number of files shown in the interface
const LARGE_FILE_BYTES = 300 * 1024 * 1024;
const OLD_FILE_DAYS = 180;
const DUP_MIN_BYTES = 1024 * 1024;
const DUP_MAX_FILES = 20000;

/** Thresholds shown in text (language-independent units). */
const LARGE_FILE_LABEL = `${Math.round(LARGE_FILE_BYTES / (1024 * 1024))} MB`;

// Absolute ban for deletion: no path containing these fragments can be deleted.
const DENY_FRAGMENTS = [
  '\\system32',
  '\\syswow64',
  '\\winsxs',
  '\\windows\\system',
  '\\windows\\assembly',
  '\\windows\\boot',
  '\\windows\\inf',
  '\\windows\\servicing',
  '\\windows\\fonts',
  '\\windows\\systemapps',
  '\\$recycle.bin\\s-1-5-18',
  '\\config\\systemprofile',
  '\\microsoft\\crypto',
  '\\microsoft\\protect',
];

// User folders that cannot be deleted themselves (files inside them are fine).
const PROTECTED_USER_DIRS = ['desktop', 'documents', 'pictures', 'music', 'videos'];

// Folder names never descended into: prevents noise and double counting.
const SKIP_DIR_NAMES = [
  'node_modules',
  '.git',
  '.svn',
  '$recycle.bin',
  'system volume information',
  'appdata',
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
];

// ------------------------------------------------------------------ kategoriler
// mode:
//   walk    -> files under the roots are scanned (roots may contain *)
//   glob    -> only files matching the pattern
//   special -> handled by dedicated code in scanner.js
const CATEGORIES = [
  {
    id: 'user_temp',
    icon: 'flask',
    risk: 'safe',
    mode: 'walk',
    roots: [TEMP],
  },
  {
    id: 'windows_temp',
    icon: 'windows',
    risk: 'caution',
    mode: 'walk',
    roots: [path.join(WINDIR, 'Temp')],
  },
  {
    id: 'browser_cache',
    icon: 'globe',
    risk: 'safe',
    mode: 'walk',
    roots: [
      path.join(LOCALAPPDATA, 'Google', 'Chrome', 'User Data', '*', 'Cache'),
      path.join(LOCALAPPDATA, 'Google', 'Chrome', 'User Data', '*', 'Code Cache'),
      path.join(LOCALAPPDATA, 'Google', 'Chrome', 'User Data', '*', 'GPUCache'),
      path.join(LOCALAPPDATA, 'Google', 'Chrome', 'User Data', '*', 'Service Worker', 'CacheStorage'),
      path.join(LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data', '*', 'Cache'),
      path.join(LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data', '*', 'Code Cache'),
      path.join(LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data', '*', 'GPUCache'),
      path.join(LOCALAPPDATA, 'BraveSoftware', 'Brave-Browser', 'User Data', '*', 'Cache'),
      path.join(LOCALAPPDATA, 'BraveSoftware', 'Brave-Browser', 'User Data', '*', 'Code Cache'),
      path.join(LOCALAPPDATA, 'Mozilla', 'Firefox', 'Profiles', '*', 'cache2'),
      path.join(APPDATA, 'Mozilla', 'Firefox', 'Profiles', '*', 'cache2'),
      path.join(APPDATA, 'Opera Software', 'Opera Stable', 'Cache'),
      path.join(APPDATA, 'Opera Software', 'Opera GX Stable', 'Cache'),
      path.join(LOCALAPPDATA, 'Vivaldi', 'User Data', '*', 'Cache'),
    ],
  },
  {
    id: 'windows_update',
    icon: 'refresh',
    risk: 'caution',
    mode: 'walk',
    roots: [path.join(WINDIR, 'SoftwareDistribution', 'Download')],
  },
  {
    id: 'thumbnails',
    icon: 'image',
    risk: 'safe',
    mode: 'glob',
    roots: [path.join(LOCALAPPDATA, 'Microsoft', 'Windows', 'Explorer', 'thumbcache_*.db')],
  },
  {
    id: 'prefetch',
    icon: 'bolt',
    risk: 'caution',
    mode: 'walk',
    roots: [path.join(WINDIR, 'Prefetch')],
  },
  {
    id: 'crash_dumps',
    icon: 'burst',
    risk: 'safe',
    mode: 'walk',
    roots: [path.join(LOCALAPPDATA, 'CrashDumps'), path.join(WINDIR, 'Minidump')],
  },
  {
    id: 'logs',
    icon: 'scroll',
    risk: 'caution',
    mode: 'glob',
    roots: [
      path.join(WINDIR, 'Logs', 'CBS', '*.log'),
      path.join(WINDIR, 'Logs', 'DISM', '*.log'),
      path.join(WINDIR, 'Logs', 'WindowsUpdate', '*.etl'),
      path.join(TEMP, '*.log'),
    ],
  },
  {
    id: 'recycle_bin',
    icon: 'trash',
    risk: 'caution',
    mode: 'special',
    roots: [],
  },
  {
    id: 'downloads_old',
    icon: 'download',
    risk: 'risky',
    mode: 'walk',
    roots: [path.join(USER_HOME, 'Downloads')],
    min_age_days: OLD_FILE_DAYS,
  },
  {
    id: 'large_files',
    icon: 'elephant',
    risk: 'risky',
    mode: 'special',
    deep_only: true,
    roots: [],
  },
  {
    id: 'duplicates',
    icon: 'copy',
    risk: 'risky',
    mode: 'special',
    deep_only: true,
    roots: [],
  },
];

const CATEGORY_BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
const SAFE_CATEGORY_IDS = CATEGORIES.filter((c) => c.risk === 'safe').map((c) => c.id);

/** Category name in the selected interface language. */
function categoryName(id) {
  return i18n.t(`cat.${id}.name`);
}

/** Category description with the threshold values filled in. */
const DESC_VARS = { days: OLD_FILE_DAYS, size: LARGE_FILE_LABEL };

function categoryDesc(id) {
  return i18n.t(`cat.${id}.desc`, DESC_VARS);
}

/**
 * Translation keys for the category text.
 *
 * A scan result is written to disk, so baking fixed text into it would be
 * wrong: opening the application in another language would leave the category
 * names in the old language. The view therefore carries the key and its
 * variables, and the interface produces the text in the selected language.
 */
function categoryKeys(id) {
  return {
    name_key: `cat.${id}.name`,
    desc_key: `cat.${id}.desc`,
    desc_vars: DESC_VARS,
  };
}

/**
 * Scanners in `special` mode have no roots of their own; the cleaner needs
 * separately allowed roots before it can delete their files.
 */
const EXTRA_DELETE_ROOTS = [USER_HOME];

/** User folders the duplicate scanner walks. */
const DUPLICATE_ROOTS = ['Downloads', 'Documents', 'Pictures', 'Videos', 'Desktop', 'OneDrive']
  .map((name) => path.join(USER_HOME, name))
  .filter((p) => fs.existsSync(p));

const DEFAULT_SETTINGS = {
  deep_scan: false,
  clean_mode: 'quarantine', // quarantine | delete
  auto_select_safe: true,
  language: 'en', // 'en' is the source language; 'auto' follows the Windows UI language
  reduce_motion: false,

  // --- AI provider (edited from the Settings screen)
  ai_provider: 'auto', // auto | openai | ollama | rules
  ai_openai_base: '', // falls back to OPENAI_DEFAULT_BASE when empty
  ai_openai_model: '', // falls back to OPENAI_DEFAULT_MODEL when empty
  ai_openai_key: '', // stored encrypted by store.js
  ai_temperature: 0.3,
  ai_max_tokens: 320,
};

function ensureDirs() {
  for (const dir of [DATA_DIR, QUARANTINE_DIR]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* ignored */
    }
  }
}

module.exports = {
  SRC_DIR,
  ROOT_DIR,
  DATA_DIR,
  QUARANTINE_DIR,
  HISTORY_FILE,
  SETTINGS_FILE,
  LAST_SCAN_FILE,

  USER_HOME,
  LOCALAPPDATA,
  APPDATA,
  PROGRAMDATA,
  WINDIR,
  TEMP,
  SYSTEM_DRIVE,

  OLLAMA_URL,
  OLLAMA_MODEL,
  OPENAI_DEFAULT_BASE,
  OPENAI_DEFAULT_MODEL,
  OPENAI_BASE,
  OPENAI_KEY,
  OPENAI_MODEL,
  AI_TIMEOUT_MS,
  AI_TEST_TIMEOUT_MS,
  AI_MODELS_TIMEOUT_MS,
  AI_PROVIDERS,

  MAX_WALK_DEPTH,
  MAX_ITEMS_PER_CATEGORY,
  LARGE_FILE_BYTES,
  LARGE_FILE_LABEL,
  OLD_FILE_DAYS,
  DUP_MIN_BYTES,
  DUP_MAX_FILES,

  DENY_FRAGMENTS,
  PROTECTED_USER_DIRS,
  SKIP_DIR_NAMES,

  CATEGORIES,
  CATEGORY_BY_ID,
  SAFE_CATEGORY_IDS,
  EXTRA_DELETE_ROOTS,
  DUPLICATE_ROOTS,
  DEFAULT_SETTINGS,

  categoryName,
  categoryDesc,
  categoryKeys,
  ensureDirs,
};
