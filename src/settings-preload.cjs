/**
 * Preload for the settings window (sandboxed, CommonJS). Exposes a minimal,
 * typed bridge so the local settings page can read/save the desktop config and
 * pick the harness source directory through native dialogs.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__dshSettings', {
  get: () => ipcRenderer.invoke('settings:get'),
  save: (patch) => ipcRenderer.invoke('settings:save', patch),
  pickDirectory: (current) => ipcRenderer.invoke('settings:pickDirectory', current),
})
