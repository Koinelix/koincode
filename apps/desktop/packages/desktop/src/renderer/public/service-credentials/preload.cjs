const { contextBridge, ipcRenderer } = require("electron");
const channel = "koincode:service-credentials-window";
contextBridge.exposeInMainWorld("serviceCredentials", Object.freeze({
  status: () => ipcRenderer.invoke(channel, { action: "status" }),
  save: (origin, path, secret, ref) => ipcRenderer.invoke(channel, { action: "save", origin, path, secret, ...(ref ? { ref } : {}) }),
  revoke: (ref) => ipcRenderer.invoke(channel, { action: "revoke", ref }),
}));
