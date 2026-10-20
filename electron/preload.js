'use strict';

/**
 * reMona (AICleaner) — preload bridge.
 *
 * Only the counted functions below are exposed to the renderer. `ipcRenderer`
 * itself, `require`, `fs` and any other Node API are not leaked.
 */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

/** Subscribes to events from the main process and returns an unsubscribe function. */
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
  i18n: {
    bundle: (code) => invoke('i18n:bundle', code),
    set: (code) => invoke('i18n:set', code),
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
    ask: (question, intent) => invoke('ai:ask', { question, intent }),
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
