/**
 * Preload for the floating status bar (sandboxed, CommonJS). The status payload
 * is pushed from main via executeJavaScript; this bridge only carries the two
 * renderer-initiated actions: manual refresh and the details dialog.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__dshStatus', {
  refresh: () => ipcRenderer.invoke('status:refresh'),
  details: () => ipcRenderer.invoke('status:details'),
})
