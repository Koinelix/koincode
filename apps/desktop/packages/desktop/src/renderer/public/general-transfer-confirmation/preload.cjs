const { contextBridge, ipcRenderer } = require("electron");
const CHANNEL = "koincode:protected-general-transfer-confirmation";
contextBridge.exposeInMainWorld("transferConfirmationControl", Object.freeze({
  invoke: (command) => ipcRenderer.invoke(CHANNEL, command),
  onReady: (callback) => { if (typeof callback === "function") ipcRenderer.once(`${CHANNEL}:ready`, () => callback()); },
  onInvalidated: (callback) => { if (typeof callback === "function") ipcRenderer.on(`${CHANNEL}:invalidated`, () => callback()); },
}));
