const { contextBridge, ipcRenderer } = require("electron");
const CHANNEL = "koincode:protected-general-setup";
contextBridge.exposeInMainWorld("generalSetupControl", Object.freeze({
  onLocaleChanged: (callback) => {
    const listener = (_event, locale) => { if (locale === "en-US" || locale === "zh-CN") callback(); };
    ipcRenderer.on("fcode:application-locale-changed", listener);
    return () => ipcRenderer.removeListener("fcode:application-locale-changed", listener);
  },
  invoke: (command) => ipcRenderer.invoke(CHANNEL, command),
  copyMnemonic: (phrase) => ipcRenderer.invoke(`${CHANNEL}:copy-mnemonic`, phrase),
  close: () => ipcRenderer.send(`${CHANNEL}:close`),
  onReady: (callback) => {
    if (typeof callback === "function") ipcRenderer.once(`${CHANNEL}:ready`, () => callback());
  },
  onRestorePassword: (callback) => {
    if (typeof callback === "function") ipcRenderer.on(`${CHANNEL}:restore-password`, (_event, value) => callback(value));
  },
  onAuthenticationPhase: (callback) => {
    if (typeof callback === "function") ipcRenderer.on(`${CHANNEL}:authentication-phase`, (_event, pending) => {
      if (typeof pending === "boolean") callback(pending);
    });
  },
  onInvalidated: (callback) => {
    if (typeof callback !== "function") return;
    ipcRenderer.on(`${CHANNEL}:invalidated`, () => callback());
  },
}));
