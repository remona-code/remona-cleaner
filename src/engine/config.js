'use strict';

/**
 * Uygulama yapılandırması, taranacak konumlar ve güvenlik sınırları.
 *
 * Bu dosya tek doğruluk kaynağıdır: hangi yolların taranabileceği ve
 * silinebileceği burada tanımlanır. Tarayıcı ve temizleyici yalnızca
 * buradaki köklerin altında çalışır.
 *
 * Kategori adları ve açıklamaları burada tutulmaz: metinler `src/i18n`
 * altındaki kataloglardan gelir (`cat.<id>.name` / `cat.<id>.desc`), böylece
 * arayüz dili değiştiğinde tarama sonucu da aynı dilde üretilir.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const i18n = require('../i18n');

// ------------------------------------------------------------------ yollar
const SRC_DIR = path.resolve(__dirname, '..');
const ROOT_DIR = path.resolve(SRC_DIR, '..');

// Electron ana süreci bunu app.getPath('userData') ile ezer; test ve
// komut satırı kullanımında proje altındaki data/ klasörü kullanılır.
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
// Sağlayıcı seçimi ve OpenAI bilgileri arayüzdeki Ayarlar ekranından yönetilir
// (settings.json). Aşağıdaki ortam değişkenleri yalnızca yedek ilk değerlerdir:
// ayar dosyasında bir değer varsa o kazanır.
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

/** Ayarlar ekranında sunulan sağlayıcılar. */
const AI_PROVIDERS = ['auto', 'openai', 'ollama', 'rules'];

// ------------------------------------------------------------------ tarama
const MAX_WALK_DEPTH = 6;
const MAX_ITEMS_PER_CATEGORY = 400; // arayüzde gösterilen en büyük dosya sayısı
const LARGE_FILE_BYTES = 300 * 1024 * 1024;
const OLD_FILE_DAYS = 180;
const DUP_MIN_BYTES = 1024 * 1024;
const DUP_MAX_FILES = 20000;

/** Metinlerde gösterilecek eşikler (dilden bağımsız birimler). */
const LARGE_FILE_LABEL = `${Math.round(LARGE_FILE_BYTES / (1024 * 1024))} MB`;

// Silme işlemleri için mutlak yasak: bu parçaları içeren hiçbir yol silinemez.
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

// Kendisi doğrudan silinemeyecek kullanıcı klasörleri (içindeki dosyalar serbest).
const PROTECTED_USER_DIRS = ['desktop', 'documents', 'pictures', 'music', 'videos'];

// Gezinirken hiç girilmeyecek klasör adları: gürültü ve çift sayım önleyici.
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
//   walk    -> roots altındaki dosyalar taranır (root'lar * içerebilir)
//   glob    -> yalnızca desene uyan dosyalar
//   special -> scanner.js içinde özel işleyici
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

/** Kategori adı, seçili arayüz dilinde. */
function categoryName(id) {
  return i18n.t(`cat.${id}.name`);
}

/** Kategori açıklaması, eşik değerleri yerleştirilmiş olarak. */
const DESC_VARS = { days: OLD_FILE_DAYS, size: LARGE_FILE_LABEL };

function categoryDesc(id) {
  return i18n.t(`cat.${id}.desc`, DESC_VARS);
}

/**
 * Kategori metninin çeviri anahtarları.
 *
 * Tarama sonucu diske yazıldığı için içine sabitlenmiş metin koymak yanlış
 * olur: uygulama başka bir dille açıldığında kategori adları eski dilde
 * kalırdı. Bu yüzden görünüm anahtarı ve değişkenleri taşır, metni seçili
 * dilde arayüz üretir.
 */
function categoryKeys(id) {
  return {
    name_key: `cat.${id}.name`,
    desc_key: `cat.${id}.desc`,
    desc_vars: DESC_VARS,
  };
}

/**
 * `special` modundaki tarayıcıların kendi kökleri yoktur; temizleyicinin
 * onların dosyalarını silebilmesi için ayrıca izin verilen kök gerekir.
 */
const EXTRA_DELETE_ROOTS = [USER_HOME];

/** Kopya tarayıcısının gezdiği kullanıcı klasörleri. */
const DUPLICATE_ROOTS = ['Downloads', 'Documents', 'Pictures', 'Videos', 'Desktop', 'OneDrive']
  .map((name) => path.join(USER_HOME, name))
  .filter((p) => fs.existsSync(p));

const DEFAULT_SETTINGS = {
  deep_scan: false,
  clean_mode: 'quarantine', // quarantine | delete
  auto_select_safe: true,
  language: 'auto', // auto = Windows dili | en | tr | de | …
  reduce_motion: false,

  // --- AI sağlayıcısı (Ayarlar ekranından düzenlenir)
  ai_provider: 'auto', // auto | openai | ollama | rules
  ai_openai_base: '', // boşsa OPENAI_DEFAULT_BASE
  ai_openai_model: '', // boşsa OPENAI_DEFAULT_MODEL
  ai_openai_key: '', // store.js içinde şifrelenerek saklanır
  ai_temperature: 0.3,
  ai_max_tokens: 320,
};

function ensureDirs() {
  for (const dir of [DATA_DIR, QUARANTINE_DIR]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* yok sayılır */
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
