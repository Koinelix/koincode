const { contextBridge, ipcRenderer } = require("electron");
const channel = "koincode:trusted-wallet-payment";
function subscribe(event, callback) {
  const listener = () => callback();
  ipcRenderer.on(event, listener);
  return () => ipcRenderer.removeListener(event, listener);
}
contextBridge.exposeInMainWorld("walletPayment", Object.freeze({
  presentation: () => ipcRenderer.invoke(channel, { action: "payment_presentation" }),
  paymentStatus: () => ipcRenderer.invoke(channel, { action: "payment_status" }),
  decidePayment: (approvalId, choice) => ipcRenderer.invoke(channel, { action: "payment_decide", approvalId, choice }),
  onPaymentChanged: callback => subscribe("koincode:trusted-wallet-payment-changed", callback),
  onLocaleChanged: callback => subscribe("fcode:application-locale-changed", callback),
}));
