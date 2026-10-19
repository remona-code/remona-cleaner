'use strict';

/**
 * Uygulama yapılandırması, taranacak konumlar ve güvenlik sınırları.
 *
 * Bu dosya tek doğruluk kaynağıdır: hangi yolların taranabileceği ve
 * silinebileceği burada tanımlanır. Tarayıcı ve temizleyici yalnızca
 * buradaki köklerin altında çalışır.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

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
    name: 'Kullanıcı Geçici Dosyaları',
    icon: 'flask',
    risk: 'safe',
    mode: 'walk',
    roots: [TEMP],
    description: 'Kurulum ve güncelleme artıkları, uygulamaların bıraktığı geçici dosyalar.',
  },
  {
    id: 'windows_temp',
    name: 'Windows Geçici Klasörü',
    icon: 'windows',
    risk: 'caution',
    mode: 'walk',
    roots: [path.join(WINDIR, 'Temp')],
    description: 'Sistem genelindeki geçici dosyalar. Kilitli olanlar atlanır.',
  },
  {
    id: 'browser_cache',
    name: 'Tarayıcı Önbellekleri',
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
    description: 'Sayfa görselleri ve kod önbelleği. Silinmesi güvenlidir, siteler biraz yavaş açılır.',
  },
  {
    id: 'windows_update',
    name: 'Windows Update Artıkları',
    icon: 'refresh',
    risk: 'caution',
    mode: 'walk',
    roots: [path.join(WINDIR, 'SoftwareDistribution', 'Download')],
    description: 'Kurulmuş güncellemelerin indirme dosyaları. Yönetici izni gerekebilir.',
  },
  {
    id: 'thumbnails',
    name: 'Küçük Resim Önbelleği',
    icon: 'image',
    risk: 'safe',
    mode: 'glob',
    roots: [path.join(LOCALAPPDATA, 'Microsoft', 'Windows', 'Explorer', 'thumbcache_*.db')],
    description: "Gezgin'deki dosya önizlemeleri. Yeniden oluşturulur.",
  },
  {
    id: 'prefetch',
    name: 'Prefetch Dosyaları',
    icon: 'bolt',
    risk: 'caution',
    mode: 'walk',
    roots: [path.join(WINDIR, 'Prefetch')],
    description: 'Uygulama açılışını hızlandıran önbellek. Silinirse ilk açılışlar yavaşlar.',
  },
  {
    id: 'crash_dumps',
    name: 'Çökme Dökümleri',
    icon: 'burst',
    risk: 'safe',
    mode: 'walk',
    roots: [path.join(LOCALAPPDATA, 'CrashDumps'), path.join(WINDIR, 'Minidump')],
    description: 'Çöken uygulamaların hata kayıtları. Sorun ayıklamıyorsanız gereksizdir.',
  },
  {
    id: 'logs',
    name: 'Sistem ve Uygulama Günlükleri',
    icon: 'scroll',
    risk: 'caution',
    mode: 'glob',
    roots: [
      path.join(WINDIR, 'Logs', 'CBS', '*.log'),
      path.join(WINDIR, 'Logs', 'DISM', '*.log'),
      path.join(WINDIR, 'Logs', 'WindowsUpdate', '*.etl'),
      path.join(TEMP, '*.log'),
    ],
    description: 'Eski kurulum ve tanılama günlükleri.',
  },
  {
    id: 'recycle_bin',
    name: 'Geri Dönüşüm Kutusu',
    icon: 'trash',
    risk: 'caution',
    mode: 'special',
    roots: [],
    description: 'Geri dönüşüm kutusuna attığınız dosyalar. Boşaltıldığında kurtarılamaz.',
  },
  {
    id: 'downloads_old',
    name: 'Eski İndirilenler',
    icon: 'download',
    risk: 'risky',
    mode: 'walk',
    roots: [path.join(USER_HOME, 'Downloads')],
    min_age_days: OLD_FILE_DAYS,
    description: `${OLD_FILE_DAYS} günden uzun süredir değişmeyen indirilenler. İçeriği sizin kararınız.`,
  },
  {
    id: 'large_files',
    name: 'Büyük Dosyalar',
    icon: 'elephant',
    risk: 'risky',
    mode: 'special',
    deep_only: true,
    roots: [],
    description: '300 MB üzerindeki dosyalar. En çok yer açan ama en çok dikkat isteyen grup.',
  },
  {
    id: 'duplicates',
    name: 'Kopya Dosyalar',
    icon: 'copy',
    risk: 'risky',
    mode: 'special',
    deep_only: true,
    roots: [],
    description: 'Aynı içeriğe sahip dosyalar. Bir kopyayı silmek güvenli, hepsini silmek değil.',
  },
];

const CATEGORY_BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
const SAFE_CATEGORY_IDS = CATEGORIES.filter((c) => c.risk === 'safe').map((c) => c.id);

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
  language: 'tr',
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

  ensureDirs,
};
