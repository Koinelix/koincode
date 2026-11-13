import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, ipcMain } from "electron";
import { generalTransferConfirmationView } from "./transferConfirmationView.js";

const CHANNEL = "koincode:protected-general-transfer-confirmation";
const MESSAGE_KEYS = ["title", "eyebrow", "separation", "testnet", "mainnet", "account", "recipient", "amount", "native", "token", "contract", "atomic",
  "maxFee", "nativeExposure", "feeType", "gasLimit", "gasPrice", "priorityFee", "nonce", "estimate", "estimateNotice", "quoteBlock", "estimateBlock", "digest",
  "remaining", "seconds", "precision", "accept", "cancel", "nextStep", "checking", "expired", ...[1, 11155111, 8453, 84532, 42161, 421614, 10, 11155420, 56, 97, 137, 80002, 43114, 43113].map((id) => `network${id}`)];
let occupied = false;
const now = () => Math.floor(performance.now());

/** Protected host callback only. A true result confirms these display fields; it never authenticates, signs or sends. */
export async function createGeneralTransferConfirmationWindow(input: {
  resourceDirectory: string; locale: string; details: unknown; signal: AbortSignal;
  nativeLifetime: { assertCurrent(): void; onInvalidated(callback: () => void): () => void };
}): Promise<{ window: BrowserWindow; result: Promise<boolean>; close(): void }> {
  if (occupied) throw new Error("GENERAL_OPERATION_BUSY");
  occupied = true;
  let win: BrowserWindow | undefined, finished = false, attached = false, unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, resolve!: (accepted: boolean) => void;
  const result = new Promise<boolean>((done) => { resolve = done; }), load = new AbortController();
  const signal = input?.signal, directory = input?.resourceDirectory, locale = input?.locale === "zh-CN" ? "zh-CN" : "en-US";
  const abort = () => finish(false);
  const finish = (accepted: boolean): void => {
    if (finished) return;
    finished = true; if (timer) clearTimeout(timer); load.abort(); signal?.removeEventListener("abort", abort);
    try { unsubscribe?.(); } catch { accepted = false; }
    if (attached) ipcMain.removeHandler(CHANNEL);
    if (win && !win.isDestroyed()) {
      try { win.webContents.send(`${CHANNEL}:invalidated`); win.destroy(); } catch { accepted = false; }
    }
    occupied = false; resolve(accepted);
  };
  try {
    if (!(signal instanceof AbortSignal) || signal.aborted) throw new Error("GENERAL_OPERATION_CANCELED");
    const assert = input.nativeLifetime.assertCurrent.bind(input.nativeLifetime), subscribe = input.nativeLifetime.onInvalidated.bind(input.nativeLifetime);
    const assertNative = () => {
      let value: unknown;
      try { value = assert(); } catch { throw new Error("GENERAL_SECRET_ADMISSION_UNAVAILABLE"); }
      if (value !== undefined) {
        if (value instanceof Promise) void value.catch(() => {});
        throw new Error("GENERAL_SECRET_ADMISSION_UNAVAILABLE");
      }
    };
    assertNative(); const view = generalTransferConfirmationView(input.details, now()), requestId = randomUUID();
    timer = setTimeout(() => finish(false), Math.max(1, view.expiresAt - now()));
    signal.addEventListener("abort", abort, { once: true });
    const subscription: unknown = subscribe(() => finish(false));
    if (typeof subscription !== "function") {
      if (subscription instanceof Promise) void subscription.catch(() => {});
      throw new Error("GENERAL_SECRET_ADMISSION_UNAVAILABLE");
    }
    unsubscribe = subscription as () => void;
    if (finished || signal.aborted) { unsubscribe(); unsubscribe = undefined; throw new Error("GENERAL_OPERATION_CANCELED"); }
    const bytes = await readFile(join(directory, `${locale}.json`), { signal: load.signal });
    if (bytes.byteLength > 65536) throw new Error("GENERAL_TRANSFER_CONFIRMATION_UNAVAILABLE");
    const messages: unknown = JSON.parse(bytes.toString("utf8"));
    if (!messages || typeof messages !== "object" || Array.isArray(messages) || Object.keys(messages).sort().join() !== [...MESSAGE_KEYS].sort().join() ||
        Object.values(messages).some((value) => typeof value !== "string" || value.length === 0 || value.length > 2048)) throw new Error("GENERAL_TRANSFER_CONFIRMATION_UNAVAILABLE");
    assertNative(); if (finished || signal.aborted || now() >= view.expiresAt) throw new Error("GENERAL_OPERATION_CANCELED");
    const url = pathToFileURL(join(directory, "index.html")).href;
    const allowed = new Set(["index.html", "confirmation.js", "style.css"].map((name) => pathToFileURL(join(directory, name)).href));
    win = new BrowserWindow({ width: 620, height: 820, minWidth: 360, minHeight: 480, show: false, title: (messages as Record<string, string>).title,
      webPreferences: { preload: join(directory, "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false,
        webSecurity: true, webviewTag: false, devTools: false, partition: `koincode-protected-transfer-${randomUUID()}` } });
    const window = win;
    const current = () => {
      assertNative();
      if (finished || signal.aborted || now() >= view.expiresAt || window.isDestroyed() || !window.isVisible() || window.isMinimized() || window.webContents.getURL() !== url)
        throw new Error("GENERAL_OPERATION_CANCELED");
    };
    win.setContentProtection(false);
    const session = win.webContents.session;
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false)); session.setPermissionCheckHandler(() => false);
    session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowed.has(details.url) }));
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault()); win.webContents.on("will-attach-webview", (event) => event.preventDefault());
    const cancel = () => finish(false);
    win.on("closed", cancel); win.on("hide", cancel); win.on("minimize", cancel); win.on("blur", cancel);
    win.webContents.on("render-process-gone", () => finish(false)); win.webContents.on("did-navigate-in-page", () => finish(false));
    ipcMain.handle(CHANNEL, (event, command: unknown) => {
      try {
        current();
        if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame?.url !== url)
          throw new Error("GENERAL_UNTRUSTED_SOURCE");
        if (!command || typeof command !== "object" || Array.isArray(command) || Buffer.byteLength(JSON.stringify(command)) > 1024) throw new Error("INVALID_REQUEST");
        const row = command as Record<string, unknown>, keys = Object.keys(row).sort().join();
        if (row.action === "bootstrap" && keys === "action") {
          const { expiresAt: _expiresAt, ...display } = view;
          return { ok: true, value: { locale, messages, view: display, requestId, remainingMs: Math.max(0, view.expiresAt - now()) } };
        }
        if (row.action !== "decide" || keys !== "accept,action,digest,requestId" || row.requestId !== requestId || row.digest !== view.digest || typeof row.accept !== "boolean")
          throw new Error("INVALID_REQUEST");
        if (row.accept && !window.isFocused()) throw new Error("GENERAL_UNTRUSTED_SOURCE");
        current(); finish(row.accept); return { ok: true };
      } catch (error) {
        const code = error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message) ? error.message : "GENERAL_TRANSFER_CONFIRMATION_UNAVAILABLE";
        return { ok: false, code };
      }
    });
    attached = true;
    await win.loadURL(url); assertNative();
    if (finished || signal.aborted || now() >= view.expiresAt) throw new Error("GENERAL_OPERATION_CANCELED");
    // The window must become visible before the renderer can bootstrap its private projection.
    win.show(); win.focus(); current(); win.webContents.send(`${CHANNEL}:ready`);
    return { window: win, result, close: () => finish(false) };
  } catch (error) {
    finish(false);
    const allowed = new Set(["GENERAL_OPERATION_CANCELED", "GENERAL_SECRET_ADMISSION_UNAVAILABLE", "GENERAL_TRANSFER_CONFIRMATION_INVALID", "GENERAL_TRANSFER_CONFIRMATION_UNAVAILABLE"]);
    throw new Error(error instanceof Error && allowed.has(error.message) ? error.message : "GENERAL_TRANSFER_CONFIRMATION_UNAVAILABLE");
  }
}
