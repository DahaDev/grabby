// src/main/preload.js
//
// Runs in an isolated context with access to Node APIs, and exposes a narrow,
// curated API to the renderer (the HTML page). The renderer cannot require()
// arbitrary Node modules — only what we expose here.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('grabby', {
  probe:           (url) => ipcRenderer.invoke('probe', { url }),
  download:        (opts) => ipcRenderer.invoke('download', opts),
  cancel:          (jobId) => ipcRenderer.invoke('cancel', { jobId }),

  openFile:        (filePath) => ipcRenderer.invoke('open-file', { filePath }),
  revealFile:      (filePath) => ipcRenderer.invoke('reveal-file', { filePath }),
  openDownloads:   () => ipcRenderer.invoke('open-downloads'),

  getSettings:     () => ipcRenderer.invoke('get-settings'),
  setSettings:     (patch) => ipcRenderer.invoke('set-settings', patch),
  pickDownloadDir: () => ipcRenderer.invoke('pick-download-dir'),

  // Streaming events. Pass a callback; we return an unsubscribe function.
  onJobUpdate: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('job-update', listener);
    return () => ipcRenderer.removeListener('job-update', listener);
  },

  // ---- Auto-updater ----
  appVersion:       () => ipcRenderer.invoke('app-version'),
  checkForUpdates:  () => ipcRenderer.invoke('updater-check'),
  downloadUpdate:   () => ipcRenderer.invoke('updater-download'),
  installUpdate:    () => ipcRenderer.invoke('updater-install'),

  // Subscribe to updater events. Returns unsubscribe.
  onUpdaterEvent: (cb) => {
    const channels = ['update-available', 'update-not-available', 'update-download-progress', 'update-downloaded'];
    const listeners = channels.map(ch => {
      const l = (_e, payload) => cb(ch, payload);
      ipcRenderer.on(ch, l);
      return [ch, l];
    });
    return () => listeners.forEach(([ch, l]) => ipcRenderer.removeListener(ch, l));
  },
});
