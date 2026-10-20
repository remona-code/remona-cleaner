'use strict';

/**
 * reMona (AICleaner) — Electron main process.
 *
 * Mimari:
 *   renderer  → interface only. It sees no file paths and cannot reach the filesystem.
 *   preload   → opens a counted set of powers through contextBridge.
 *   main      → runs scan/clean/AI work and keeps full paths in memory.
 *
 * The list of files to clean never comes from the interface; a selection is
 * carried only as category and item identifiers, and paths are resolved in
 * the main process from the in-memory scan result.
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, shell, nativeTheme, safeStorage } = require('electron');

/**
 * The userData path is derived from the product name, so it is pinned here.
 * Otherwise another reMona application installed on the same machine (an IDE,
 * for example) would share the same folder and the same single-instance lock;
 * the second process would close silently with a Chromium cache error.
 */
const USER_DATA_DIR = path.join(app.getPath('appData'), 'reMona AICleaner');
app.setPath('userData', USER_DATA_DIR);

/**
 * Rebranding: while the application was named AICleaner its data lived in
 * `%APPDATA%\AICleaner\data`. The product name became reMona, so the userData
 * path changed; without carrying the old folder over, settings, history and
 * quarantined files would be unreachable. It is copied rather than moved, so an older version still finds its data in place.
 */
function migrateLegacyData(targetDir) {
  try {
    const legacyDir = path.join(app.getPath('appData'), 'AICleaner', 'data');
    if (path.resolve(legacyDir) === path.resolve(targetDir)) return;
    if (fs.existsSync(targetDir) || !fs.existsSync(legacyDir)) return;
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.cpSync(legacyDir, targetDir, { recursive: true });
  } catch {
    /* the app still opens with an empty data folder if the copy fails */
  }
}

// The engine reads its data folder from the environment, so this must run
// BEFORE the engine is required.
process.env.AICLEANER_DATA_DIR = path.join(app.getPath('userData'), 'data');
migrateLegacyData(process.env.AICLEANER_DATA_DIR);

const config = require('../src/engine/config');
const scanner = require('../src/engine/scanner');
const ai = require('../src/engine/ai');
const cleaner = require('../src/engine/cleaner');
const store = require('../src/engine/store');
const trash = require('../src/engine/trash');
const i18n = require('../src/i18n');

const IS_DEV = process.argv.includes('--dev') || !app.isPackaged;

/**
 * QA helper: `electron . --capture=<file.png>` draws the interface in a real
 * window, writes a PNG after a short delay and closes the application.
 * It is for documentation and visual checks; a normal launch does nothing.
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
 * The operating system's encryption vault (DPAPI on Windows) keeps the API
 * key out of plain text in settings.json. Without a vault the store keeps
 * writing plain text; the only difference is the on-disk format.
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
    /* without encryption the key is stored in plain text */
  }
}
wireSecretCipher();

/** Returns a QA flag such as `--locale=tr` when present (never written to settings). */
function forcedLocale() {
  const arg = process.argv.find((value) => value.startsWith('--locale'));
  if (!arg || !arg.includes('=')) return null;
  return arg.slice(arg.indexOf('=') + 1) || null;
}

/**
 * Resolves the interface language: a concrete language from settings wins,
 * "auto" follows the Windows display language, and an unsupported language
 * (Finnish, for example) falls back to English automatically.
 */
async function applyLocale() {
  const forced = forcedLocale();
  if (forced) return i18n.setLocale(forced);

  const settings = await store.getSettings();
  const systemLocale = app.getLocale();
  const wanted =
    settings.language && settings.language !== 'auto' ? settings.language : systemLocale;
  return i18n.setLocale(wanted);
}

/** @type {BrowserWindow|null} */
let mainWindow = null;
/** @type {{id: string, result: object}|null} Full scan result (full paths stay in memory). */
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

  // Keyboard shortcuts in a frameless window (there is no menu).
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

  // External links never open inside the application.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
}

// ------------------------------------------------------------------ helpers
function requireScan() {
  if (!currentScan) {
    const err = new Error(i18n.t('err.noScan'));
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
      // Brand is reMona; AICleaner is kept as the product name (compatibility and identity).
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
      locale: i18n.getLocale(),
      systemLocale: app.getLocale(),
      locales: i18n.availableLocales(),
      rtl: i18n.localeMeta().rtl,
    })
  );

  ipcMain.handle('app:openDataDir', async () => {
    await shell.openPath(config.DATA_DIR);
    return ok(true);
  });

  ipcMain.handle('app:reveal', async (_event, target) => {
    // Only paths that appear in a scan result can be opened.
    const known = currentScan
      ? currentScan.result.categories.some((cat) => (cat._full || []).some((r) => r.path === target))
      : false;
    if (!known) return fail(i18n.t('err.revealNotInScan'));
    shell.showItemInFolder(target);
    return ok(true);
  });

  // --- dil
  ipcMain.handle('i18n:bundle', (_event, code) => ok(i18n.bundle(code)));
  ipcMain.handle('i18n:set', async (_event, code) => {
    const saved = await store.saveSettings({ language: code || 'auto' });
    await applyLocale();
    ai.resetProviderCache();
    return ok({ ...i18n.bundle(), settings: saved });
  });

  // --- settings (the API key never reaches the interface in raw form)
  ipcMain.handle('settings:get', async () => ok(await store.getPublicSettings()));
  ipcMain.handle('settings:set', async (_event, patch) => {
    const saved = await store.saveSettings(patch || {});
    if (patch && 'language' in patch) await applyLocale();
    ai.resetProviderCache();
    return ok(saved);
  });

  // --- AI provider
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

  // --- scanning
  ipcMain.handle('scan:status', () => ok({ scanning: scanInFlight, hasScan: Boolean(currentScan) }));
  // A saved view carries text formatted in the language of the moment it was
  // scanned; it is regenerated in the selected language before it is sent.
  ipcMain.handle('scan:last', async () => {
    const view = await store.getLastScan();
    return ok(view ? scanner.localizeView(view) : null);
  });
  ipcMain.handle('scan:disk', async () => ok(await scanner.diskInfo()));
  ipcMain.handle('scan:counts', () =>
    ok({
      categories: config.CATEGORIES.map((c) => ({
        id: c.id,
        name: config.categoryName(c.id),
        risk: c.risk,
        deep_only: Boolean(c.deep_only),
      })),
      safe_ids: config.SAFE_CATEGORY_IDS,
    })
  );

  ipcMain.handle('scan:start', async (_event, options = {}) => {
    if (scanInFlight) return fail(i18n.t('err.scanRunning'));
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
      const result = await ai.ask(payload.question, currentScan ? currentScan.result : null, {
        intent: payload.intent,
      });
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

  // --- cleaning
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
    if (cleanInFlight) return fail(i18n.t('err.cleanRunning'));
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

  // --- history
  ipcMain.handle('history:list', async () => ok(await store.getHistory()));
  ipcMain.handle('history:clear', async () => ok(await store.clearHistory()));

  // --- recycle bin
  ipcMain.handle('recycle:stats', async (_event, options = {}) =>
    ok(await trash.stats({ refresh: Boolean(options.refresh) }))
  );
}

// ------------------------------------------------------------------ lifecycle
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

  app.whenReady().then(async () => {
    config.ensureDirs();
    await applyLocale();
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
