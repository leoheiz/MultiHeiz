'use strict';

/**
 * Minimal preload for the popover overlay WebContentsView.
 * Isolated + sandboxed; only popover IPC channels.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mhPopover', {
  onRender: (handler) => {
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on('popover:render', listener);
    return () => ipcRenderer.removeListener('popover:render', listener);
  },
  onUpdate: (handler) => {
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on('popover:update', listener);
    return () => ipcRenderer.removeListener('popover:update', listener);
  },
  onClear: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('popover:clear', listener);
    return () => ipcRenderer.removeListener('popover:clear', listener);
  },
  measure: (size) => ipcRenderer.send('popover:measured', size),
  action: (payload) => ipcRenderer.send('popover:action', payload || {}),
  pointer: (phase) => ipcRenderer.send('popover:pointer', { phase }),
  close: (reason) => ipcRenderer.send('popover:close', { reason: reason || '' }),
  ready: () => ipcRenderer.send('popover:ready'),
});
