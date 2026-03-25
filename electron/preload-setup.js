const { contextBridge, ipcRenderer, shell } = require("electron");

contextBridge.exposeInMainWorld("setupAPI", {
  saveConfig: (config) => ipcRenderer.send("setup-save", config),
  openExternal: (url) => ipcRenderer.send("setup-open-url", url),
});
