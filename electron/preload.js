'use strict';

/**
 * reMona (AICleaner) — preload köprüsü.
 *
 * Renderer'a yalnızca aşağıdaki sayılı işlevler açılır. `ipcRenderer`ın
 * kendisi, `require`, `fs` veya herhangi bir Node API'si sızdırılmaz.
 */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

/** Ana süreçten gelen olayları dinler; geriye abonelikten çıkma işlevi döner. */
function on(channel, callback) {
  const allowed = ['scan:progress', 'scan:done', 'scan:error', 'clean:progress', 'clean:done', 'window:maximized'];
  if (!allowed.includes(channel)) return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  app: {
    info: () => invoke('app:info'),
    openDataDir: () => invoke('app:openDataDir'),
    reveal: (target) => invoke('app:reveal', target),
  },
  window: {
    minimize: () => invoke('window:minimize'),
    toggleMaximize: () => invoke('window:toggleMaximize'),
    close: () => invoke('window:close'),
  },
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
  },
  scan: {
    start: (options) => invoke('scan:start', options),
    status: () => invoke('scan:status'),
    last: () => invoke('scan:last'),
    disk: () => invoke('scan:disk'),
    counts: () => invoke('scan:counts'),
  },
  ai: {
    analyze: () => invoke('ai:analyze'),
    provider: (options) => invoke('ai:provider', options),
    ask: (question) => invoke('ai:ask', { question }),
    pick: (targetBytes) => invoke('ai:pick', { targetBytes }),
    config: () => invoke('ai:config'),
    models: () => invoke('ai:models'),
    test: (model) => invoke('ai:test', { model }),
  },
  clean: {
    audit: (categoryIds) => invoke('clean:audit', { categoryIds }),
    preview: (payload) => invoke('clean:preview', payload),
    run: (payload) => invoke('clean:run', payload),
  },
  quarantine: {
    list: () => invoke('quarantine:list'),
    usage: () => invoke('quarantine:usage'),
    restore: (session) => invoke('quarantine:restore', { session }),
    purge: (session) => invoke('quarantine:purge', { session }),
  },
  history: {
    list: () => invoke('history:list'),
    clear: () => invoke('history:clear'),
  },
  recycle: {
    stats: (options) => invoke('recycle:stats', options),
  },
  on,
};

contextBridge.exposeInMainWorld('aicleaner', api);
