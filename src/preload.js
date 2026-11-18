'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ms', {
  // 配置
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (cfg) => ipcRenderer.invoke('config:save', cfg),
  appInfo: () => ipcRenderer.invoke('app:info'),

  // 窗口
  setAlwaysOnTop: (flag) => ipcRenderer.invoke('win:always-on-top', flag),
  isAlwaysOnTop: () => ipcRenderer.invoke('win:is-always-on-top'),
  syncSystemTheme: (bg) => ipcRenderer.invoke('system:theme', bg),
  setProgress: (value) => ipcRenderer.invoke('win:progress', value),
  notifyDone: (payload) => ipcRenderer.invoke('notify:done', payload),

  // 剪贴板
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),

  // 目录
  pickDir: (defaultPath) => ipcRenderer.invoke('dir:pick', defaultPath),
  checkDir: (p) => ipcRenderer.invoke('dir:check', p),
  homeDir: () => ipcRenderer.invoke('dir:home'),

  // PTY
  createPty: (opts) => ipcRenderer.invoke('pty:create', opts),
  writePty: (id, data) => ipcRenderer.send('pty:input', { id, data }),
  resizePty: (id, cols, rows) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  killPty: (id) => ipcRenderer.send('pty:kill', { id }),
  ptyStats: () => ipcRenderer.invoke('pty:stats'),

  // 事件
  onPtyData: (cb) => ipcRenderer.on('pty:data', (_e, msg) => cb(msg)),
  onPtyExit: (cb) => ipcRenderer.on('pty:exit', (_e, msg) => cb(msg)),

  platform: process.platform,
});
