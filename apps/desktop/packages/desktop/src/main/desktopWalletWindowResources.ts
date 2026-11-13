import { desktopPaymentNetwork } from "../wallet/paymentNetwork.js";
import { BrowserWindow, dialog } from "electron";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isAllowedWalletResource } from "./desktopWalletWindowPolicy.js";

type Locale = "en-US" | "zh-CN";
type WalletMessages = Record<string, string> & {
  cancel: string;
  create: string;
  confirmProfileTitle: string;
  confirmProfileMessage: string;
  confirmProfileDetail: string;
  authReason: string;
};

export async function confirmWalletWindowAction(window: BrowserWindow, text: Record<string, string>, profile: boolean): Promise<boolean> {
  const title = profile ? text.confirmProfileTitle : text.externalClientTitle;
  const message = profile ? text.confirmProfileMessage : text.externalClientMessage;
  if (typeof title !== "string" || typeof message !== "string") throw new Error("WALLET_UNAVAILABLE");
  const result = await dialog.showMessageBox(window, { type: profile ? "warning" : "question",
    title, message,
    ...(profile ? { detail: text.confirmProfileDetail } : {}),
    buttons: [text.cancel!, profile ? text.create! : text.confirm!], defaultId: 0, cancelId: 0 });
  return result.response === 1;
}

export async function readWalletMessages(
  resourceDirectory: string,
  requestedLocale: string,
): Promise<WalletMessages> {
  const locale: Locale = requestedLocale === "zh-CN" ? "zh-CN" : "en-US";
  const text: unknown = JSON.parse(
    await readFile(join(resourceDirectory, `${locale}.json`), "utf8"),
  );
  if (!text || typeof text !== "object" || Array.isArray(text))
    throw new Error("WALLET_UNAVAILABLE");
  const values = text as Record<string, unknown>;
  for (const key of [
    "cancel",
    "create",
    "confirmProfileTitle",
    "confirmProfileMessage",
    "confirmProfileDetail",
    "authReason",
  ]) {
    if (typeof values[key] !== "string" || values[key].length > 2048)
      throw new Error("WALLET_UNAVAILABLE");
  }
  return text as WalletMessages;
}

/** Public presentation only; no wallet state read or operation is performed. */
export async function readWalletPresentation(resourceDirectory: string, locale: string, assertCurrent: () => void) {
  const text = await readWalletMessages(resourceDirectory, locale);
  assertCurrent();
  return { text, network: desktopPaymentNetwork().network };
}

export function createWalletBrowserWindow(resourceDirectory: string, paymentOnly = false): BrowserWindow {
  const allowedResources = (paymentOnly ? ["payment.html", "payment-preload.cjs", "payment-confirmation.js", "payments.js", "style.css"] : ["index.html", "settings.js", "payments.js", "view.js", "history.js", "home.js", "general.js", "general-rpc-settings.js", "network-visibility.js", "general-custom-summary.js", "custom-assets.js", "style.css"]).map(
    (name) => pathToFileURL(join(resourceDirectory, name)).href,
  );
  const win = new BrowserWindow({
    width: paymentOnly ? 400 : 480,
    height: paymentOnly ? 480 : 780,
    minWidth: paymentOnly ? 320 : 360,
    minHeight: paymentOnly ? 340 : 400,
    show: false,
    title: paymentOnly ? "KoinCode Payment" : "KoinCode Wallet",
    webPreferences: {
      preload: join(resourceDirectory, paymentOnly ? "payment-preload.cjs" : "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      partition: paymentOnly ? "koincode-wallet-payment-trusted" : "koincode-wallet-trusted",
    },
  });
  try {
    win.setContentProtection(false);
    const walletSession = win.webContents.session;
    walletSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    walletSession.setPermissionCheckHandler(() => false);
    walletSession.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !isAllowedWalletResource(details.url, allowedResources) });
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.webContents.on("will-attach-webview", (event) => event.preventDefault());
    return win;
  } catch (error) {
    if (!win.isDestroyed()) win.destroy();
    throw error;
  }
}

/** Attempt every cleanup without treating a failed lock as proof of safety. */
export function runWalletCleanup(steps: Array<() => void>): void {
  for (const step of steps) {
    try { step(); } catch { /* Cleanup failures must not skip unrelated resources. */ }
  }
}
