const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('coros', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  chooseDirectory: (defaultPath) => ipcRenderer.invoke('directory:choose', defaultPath),
  login: (clientId) => ipcRenderer.invoke('spotify:login', clientId),
  restoreSpotify: (clientId) => ipcRenderer.invoke('spotify:restore', clientId),
  getPlaylists: () => ipcRenderer.invoke('spotify:playlists'),
  download: (playlist, config) => ipcRenderer.invoke('download:start', playlist, config),
  detectWatch: (configuredPath) => ipcRenderer.invoke('watch:detect', configuredPath),
  ejectWatch: (configuredPath) => ipcRenderer.invoke('watch:eject', configuredPath),
  onDownloadProgress: (callback) => ipcRenderer.on('download:progress', (_event, output) => callback(output)),
})