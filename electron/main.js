'use strict';

/**
 * reMona (AICleaner) — Electron ana süreci.
 *
 * Mimari:
 *   renderer  → yalnızca arayüz. Dosya yolu görmez, dosya sistemine erişemez.
 *   preload   → contextBridge ile sayılan yetkileri açar.
 *   main      → tarama/temizlik/AI işlerini yürütür, tam yolları bellekte tutar.
 *
 * Temizlenecek dosya listesi hiçbir zaman arayüzden gelmez; seçim yalnızca
 * kategori kimliği ve öğe kimliği olarak iletilir, yollar ana süreçte
 * bellekteki tarama sonucundan çözülür.
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, shell, nativeTheme, safeStorage } = require('electron');

/**
 * userData yolu ürün adından türetildiği için burada açıkça sabitlenir.
 * Aksi hâlde aynı makinede kurulu başka bir reMona uygulamasıyla (ör. IDE)
 * aynı klasör ve aynı tek örnek kilidi paylaşılır; ikinci süreç sessizce
 * kapanır ve Chromium önbelleği "Erişim engellendi" hatası verir.
 */
const USER_DATA_DIR = path.join(app.getPath('appData'), 'reMona AICleaner');
app.setPath('userData', USER_DATA_DIR);

/**
 * Marka geçişi: uygulama adı AICleaner iken veri `%APPDATA%\AICleaner\data`
 * altındaydı. Ürün adı reMona olduğu için userData yolu değişti; ilk açılışta
 * eski klasör taşınmazsa ayarlar, geçmiş ve karantinadaki dosyalar erişilemez
 * kalırdı. Kopyalanır (taşınmaz) ki eski sürüm açılırsa verisi yerinde olsun.
 */
function migrateLegacyData(targetDir) {
  try {
    const legacyDir = path.join(app.getPath('appData'), 'AICleaner', 'data');
    if (path.resolve(legacyDir) === path.resolve(targetDir)) return;
    if (fs.existsSync(targetDir) || !fs.existsSync(legacyDir)) return;
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.cpSync(legacyDir, targetDir, { recursive: true });
  } catch {
    /* taşıma başarısız olsa da uygulama boş veri klasörüyle açılır */
  }
}

// Motor, veri klasörünü ortam değişkeninden okur; bu yüzden require'dan
// ÖNCE ayarlanmalıdır.
process.env.AICLEANER_DATA_DIR = path.join(app.getPath('userData'), 'data');
migrateLegacyData(process.env.AICLEANER_DATA_DIR);

const config = require('../src/engine/config');
const scanner = require('../src/engine/scanner');
const ai = require('../src/engine/ai');
const cleaner = require('../src/engine/cleaner');
const store = require('../src/engine/store');
const trash = require('../src/engine/trash');

const IS_DEV = process.argv.includes('--dev') || !app.isPackaged;

/**
 * QA yardımcısı: `electron . --capture=<dosya.png>` arayüzü gerçek bir
 * pencerede çizer, kısa bir beklemeden sonra PNG yazar ve uygulamayı kapatır.
 * Belge ve görsel doğrulama içindir; normal açılışta hiçbir şey yapmaz.
 */
function captureIfRequested() {
  const arg = process.argv.find((value) => value.startsWith('--capture'));
  if (!arg || !mainWindow) return;
  const target = path.resolve(arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : 'capture.png');

  setTimeout(async () => {
    try {
      const image = await mainWindow.webContents.capturePage();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, image.toPNG());
      console.log(`capture: ${target}`);
    } catch (error) {
      console.error(`capture failed: ${error && error.message}`);
    } finally {
      app.quit();
    }
  }, 1600);
}

/**
 * API anahtarı settings.json içinde düz metin durmasın diye işletim sisteminin
 * şifreleme kasası kullanılır (Windows'ta DPAPI). Kasa yoksa store düz yazmaya
 * devam eder; davranış farkı yalnızca diskteki biçimdir.
 */
function wireSecretCipher() {
  try {
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      store.setSecretCipher({
        encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
        decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
      });
    }
  } catch {
    /* şifreleme yoksa anahtar düz saklanır */
  }
}
wireSecretCipher();

/** @type {BrowserWindow|null} */
let mainWindow = null;
/** @type {{id: string, result: object}|null} Tam tarama sonucu (tam yollar bellekte kalır). */
let currentScan = null;
let scanInFlight = false;
let cleanInFlight = false;

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ------------------------------------------------------------------ pencere
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#07090e',
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: IS_DEV,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    captureIfRequested();
  });

  mainWindow.on('maximize', () => send('window:maximized', true));
  mainWindow.on('unmaximize', () => send('window:maximized', false));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Çerçevesiz pencerede klavye kısayolları (menü yok).
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = String(input.key || '').toLowerCase();
    if (key === 'f12' || (input.control && input.shift && key === 'i')) {
      if (IS_DEV) {
        mainWindow.webContents.toggleDevTools();
        event.preventDefault();
      }
    }
    if (input.key === 'F5' || (input.control && key === 'r')) {
      mainWindow.webContents.reload();
      event.preventDefault();
    }
  });

  // Dış bağlantılar asla uygulama içinde açılmaz.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
}

// ------------------------------------------------------------------ yardımcı
function requireScan() {
  if (!currentScan) {
    const err = new Error('Önce tarama yapmalısınız');
    err.code = 'NO_SCAN';
    throw err;
  }
  return currentScan.result;
}

function ok(data) {
  return { ok: true, data };
}

function fail(error) {
  return { ok: false, error: String((error && error.message) || error) };
}

// ------------------------------------------------------------------ IPC
function registerIpc() {
  // --- pencere denetimi
  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize();
    return ok(true);
  });
  ipcMain.handle('window:toggleMaximize', () => {
    if (!mainWindow) return ok(false);
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return ok(mainWindow.isMaximized());
  });
  ipcMain.handle('window:close', () => {
    mainWindow?.close();
    return ok(true);
  });

  // --- uygulama bilgisi
  ipcMain.handle('app:info', () =>
    ok({
      // Marka reMona; AICleaner ürün adı olarak korunur (uyumluluk ve kimlik).
      name: 'reMona',
      productLine: 'AICleaner',
      fullName: 'reMona · AICleaner',
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      dataDir: config.DATA_DIR,
      quarantineDir: config.QUARANTINE_DIR,
      drive: config.SYSTEM_DRIVE,
      darkMode: nativeTheme.shouldUseDarkColors,
      isDev: IS_DEV,
    })
  );

  ipcMain.handle('app:openDataDir', async () => {
    await shell.openPath(config.DATA_DIR);
    return ok(true);
  });

  ipcMain.handle('app:reveal', async (_event, target) => {
    // Yalnızca tarama sonucunda geçen yollar açılabilir.
    const known = currentScan
      ? currentScan.result.categories.some((cat) => (cat._full || []).some((r) => r.path === target))
      : false;
    if (!known) return fail('Bu yol bu taramada bulunmuyor');
    shell.showItemInFolder(target);
    return ok(true);
  });

  // --- ayarlar (API anahtarı arayüze asla ham gitmez)
  ipcMain.handle('settings:get', async () => ok(await store.getPublicSettings()));
  ipcMain.handle('settings:set', async (_event, patch) => {
    const saved = await store.saveSettings(patch || {});
    ai.resetProviderCache();
    return ok(saved);
  });

  // --- AI sağlayıcısı
  ipcMain.handle('ai:config', async () => {
    const cfg = await store.getAiConfig();
    return ok({
      provider: cfg.provider,
      base: cfg.base,
      model: cfg.model,
      has_key: cfg.has_key,
      key_source: cfg.key_source,
      base_source: cfg.base_source,
      model_source: cfg.model_source,
      temperature: cfg.temperature,
      max_tokens: cfg.max_tokens,
      providers: config.AI_PROVIDERS,
      defaults: {
        base: config.OPENAI_DEFAULT_BASE,
        model: config.OPENAI_DEFAULT_MODEL,
      },
    });
  });

  ipcMain.handle('ai:models', async () => {
    const result = await ai.listModels();
    return ok(result);
  });

  ipcMain.handle('ai:test', async (_event, payload = {}) => {
    const result = await ai.testConnection(payload.model);
    return ok(result);
  });

  // --- tarama
  ipcMain.handle('scan:status', () => ok({ scanning: scanInFlight, hasScan: Boolean(currentScan) }));
  ipcMain.handle('scan:last', async () => ok(await store.getLastScan()));
  ipcMain.handle('scan:disk', async () => ok(await scanner.diskInfo()));
  ipcMain.handle('scan:counts', () =>
    ok({
      categories: config.CATEGORIES.map((c) => ({
        id: c.id,
        name: c.name,
        risk: c.risk,
        deep_only: Boolean(c.deep_only),
      })),
      safe_ids: config.SAFE_CATEGORY_IDS,
    })
  );

  ipcMain.handle('scan:start', async (_event, options = {}) => {
    if (scanInFlight) return fail('Tarama zaten çalışıyor');
    scanInFlight = true;
    const deep = Boolean(options.deep);

    try {
      const result = await scanner.scan({
        deep,
        onProgress: (progress) => send('scan:progress', progress),
      });

      currentScan = { id: `scan-${Date.now()}`, result };
      const view = scanner.publicView(result);
      await store.saveLastScan(view);

      const analysis = await ai.analyze(result);
      send('scan:done', { scanId: currentScan.id, view, analysis });
      return ok({ scanId: currentScan.id, view, analysis });
    } catch (error) {
      send('scan:error', { error: String((error && error.message) || error) });
      return fail(error);
    } finally {
      scanInFlight = false;
    }
  });

  // --- AI
  ipcMain.handle('ai:analyze', async () => {
    try {
      return ok(await ai.analyze(requireScan()));
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('ai:provider', async (_event, options = {}) =>
    ok(await ai.providerStatus({ refresh: Boolean(options.refresh) }))
  );

  ipcMain.handle('ai:ask', async (_event, payload = {}) => {
    try {
      const result = await ai.ask(payload.question, currentScan ? currentScan.result : null);
      return ok(result);
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('ai:pick', async (_event, payload = {}) => {
    try {
      const target = Math.max(0, Number(payload.targetBytes) || 0);
      return ok(await ai.smartPick(requireScan(), target));
    } catch (error) {
      return fail(error);
    }
  });

  // --- temizlik
  ipcMain.handle('clean:audit', async (_event, payload = {}) => {
    try {
      return ok(await cleaner.auditSelection(requireScan(), payload.categoryIds || []));
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('clean:preview', async (_event, payload = {}) => {
    try {
      const report = await cleaner.preview(
        requireScan(),
        payload.categoryIds || [],
        payload.itemIds || []
      );
      return ok(report);
    } catch (error) {
      return fail(error);
    }
  });

  ipcMain.handle('clean:run', async (_event, payload = {}) => {
    if (cleanInFlight) return fail('Temizlik zaten çalışıyor');
    cleanInFlight = true;
    try {
      const settings = await store.getSettings();
      const report = await cleaner.clean({
        scanResult: requireScan(),
        categoryIds: payload.categoryIds || [],
        itemIds: payload.itemIds || [],
        mode: payload.mode || settings.clean_mode,
        onProgress: (progress) => send('clean:progress', progress),
      });
      send('clean:done', report);
      return ok(report);
    } catch (error) {
      return fail(error);
    } finally {
      cleanInFlight = false;
    }
  });

  // --- karantina
  ipcMain.handle('quarantine:list', async () => ok(await cleaner.listQuarantine()));
  ipcMain.handle('quarantine:usage', async () => ok(await cleaner.quarantineUsage()));
  ipcMain.handle('quarantine:restore', async (_event, payload = {}) => {
    const report = await cleaner.restoreSession(payload.session, {
      onProgress: (progress) => send('clean:progress', progress),
    });
    return ok(report);
  });
  ipcMain.handle('quarantine:purge', async (_event, payload = {}) => {
    const report = await cleaner.purgeSession(payload.session);
    return ok(report);
  });

  // --- geçmiş
  ipcMain.handle('history:list', async () => ok(await store.getHistory()));
  ipcMain.handle('history:clear', async () => ok(await store.clearHistory()));

  // --- geri dönüşüm kutusu
  ipcMain.handle('recycle:stats', async (_event, options = {}) =>
    ok(await trash.stats({ refresh: Boolean(options.refresh) }))
  );
}

// ------------------------------------------------------------------ yaşam
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    config.ensureDirs();
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
