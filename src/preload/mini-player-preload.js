'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mhMini', {
  setOpacityPercent: (pct) => ipcRenderer.invoke('mini-player:set-opacity', pct),
  close: () => ipcRenderer.invoke('mini-player:close'),
  getInfo: () => ipcRenderer.invoke('mini-player:info'),
  toggleLock: () => ipcRenderer.invoke('mini-player:toggle-lock'),
  media: (cmd, value) => ipcRenderer.invoke('mini-player:media', { cmd, value }),
  mediaState: () => ipcRenderer.invoke('mini-player:media-state'),
  onLockHint: (handler) => {
    const listener = (_e, payload) => {
      if (typeof handler === 'function') handler(payload);
    };
    ipcRenderer.on('mini-player:lock-hint', listener);
    return () => ipcRenderer.removeListener('mini-player:lock-hint', listener);
  },
  onState: (handler) => {
    const listener = (_e, payload) => {
      if (typeof handler === 'function') handler(payload);
    };
    ipcRenderer.on('mini-player:state', listener);
    return () => ipcRenderer.removeListener('mini-player:state', listener);
  },
});
