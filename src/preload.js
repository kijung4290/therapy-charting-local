'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('localDesktop', {
  isDesktopApp: true,
  openDataFolder: () => ipcRenderer.invoke('local:open-data-folder'),
  openBackupFolder: () => ipcRenderer.invoke('local:open-backup-folder'),
  getVersion: () => ipcRenderer.invoke('local:get-version'),
  getUpdateStatus: () => ipcRenderer.invoke('local:get-update-status'),
  checkForUpdates: () => ipcRenderer.invoke('local:check-updates'),
  installUpdate: () => ipcRenderer.invoke('local:install-update'),
  onUpdateStatus: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('local:update-status', listener);
    return () => ipcRenderer.removeListener('local:update-status', listener);
  },
  onWindowShown: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('local:window-shown', listener);
    return () => ipcRenderer.removeListener('local:window-shown', listener);
  },
});
