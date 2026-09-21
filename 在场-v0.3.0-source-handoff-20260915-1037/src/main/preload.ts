import { contextBridge, ipcRenderer } from 'electron';
import type { Bridge, RunEvent } from '../shared/types';
const bridge: Bridge = {
  state: () => ipcRenderer.invoke('state'),
  messages: (id) => ipcRenderer.invoke('messages', id),
  draft: (id) => ipcRenderer.invoke('draft', id),
  saveDraft: (input) => ipcRenderer.invoke('draft:save', input),
  draftInfo: id => ipcRenderer.invoke('draft:info', id),
  unsavedDrafts: () => ipcRenderer.invoke('draft:unsaved'),
  persistDraft: input => ipcRenderer.invoke('draft:persist', input),
  send: (input) => ipcRenderer.invoke('send', input),
  stop: () => ipcRenderer.invoke('stop'),
  saveSettings: (input) => ipcRenderer.invoke('settings:save', input),
  testConnection: (input) => ipcRenderer.invoke('connection:test', input),
  deleteKey: () => ipcRenderer.invoke('key:delete'),
  interfaces: () => ipcRenderer.invoke('interfaces'),
  setInterfaceEnabled: (input) => ipcRenderer.invoke('interface:set-enabled', input),
  installPlugin: () => ipcRenderer.invoke('plugin:install'),
  upgradePlugin: (id) => ipcRenderer.invoke('plugin:upgrade', { id }),
  uninstallPlugin: (id) => ipcRenderer.invoke('plugin:uninstall', { id }),
  cancelConnection: () => ipcRenderer.invoke('connection:cancel'),
  memory: (input) => ipcRenderer.invoke('memory', input),
  runtimeOverview: () => ipcRenderer.invoke('runtime:overview'),
  adoptWorld: (input) => ipcRenderer.invoke('runtime:adopt-world', input),
  evidence: (id) => ipcRenderer.invoke('runtime:evidence', id),
  goal: (input) => ipcRenderer.invoke('runtime:goal', input),
  feedback: (input) => ipcRenderer.invoke('runtime:feedback', input),
  retryProcessing: (id) => ipcRenderer.invoke('runtime:retry', id),
  reconcileAction: (id) => ipcRenderer.invoke('runtime:reconcile', id),
  actionState: (id) => ipcRenderer.invoke('runtime:action', id),
  permission: (input) => ipcRenderer.invoke('runtime:permission', input),
  deleteConversation: (id) => ipcRenderer.invoke('conversation:delete', id),
  clearData: () => ipcRenderer.invoke('data:clear'),
  action: (input) => ipcRenderer.invoke('action', input),
  attachText: () => ipcRenderer.invoke('text:attach'),
  attachImage: () => ipcRenderer.invoke('image:attach'),
  exportData: () => ipcRenderer.invoke('data:export'),
  openLink: (url) => ipcRenderer.invoke('link:open', url),
  copyText: (text) => ipcRenderer.invoke('text:copy', text),
  window: (action) => ipcRenderer.send('window', action),
  onEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, event: RunEvent) => callback(event);
    ipcRenderer.on('zaichang:event', listener);
    return () => ipcRenderer.removeListener('zaichang:event', listener);
  },
};
contextBridge.exposeInMainWorld('zaichang', bridge);
