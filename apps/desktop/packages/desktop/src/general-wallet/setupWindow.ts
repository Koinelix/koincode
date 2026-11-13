import { dispatchNamedSetup } from "./accountNames.js";
import { copyGeneralMnemonic } from "./mnemonicClipboard.js";
import { randomUUID } from "node:crypto";
import { BrowserWindow, clipboard, ipcMain, type IpcMainInvokeEvent } from "electron";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { assertGeneralRestorePasswordRequest } from "./restoreReplies.js";
import { assertGeneralSetupReply } from "./setupReplies.js";

const CHANNEL = "koincode:protected-general-setup";
const TIMEOUT_MS = 120_000;
const MAX_COMMAND_BYTES = 8192;
const MAX_MESSAGES_BYTES = 64 * 1024;
const MAX_REPLY_BYTES = 512 * 1024;
type Session = { dispatch(command: unknown): Promise<unknown>; close(): Promise<void> };

/** The caller supplies an explicit native or local-system lifetime; renderer input is never admission. */
export async function createGeneralSetupWindow(input: {
  resourceDirectory: string;
  locale: string | (() => string);
  management?: "basic" | "extended";
  initialView?: "create" | "import" | "export";
  clipboard?: Pick<typeof clipboard, "writeText">;
  nativeLifetime?: { assertCurrent(): void; onInvalidated(callback: () => void): () => void };
  localLifetime?: { assertCurrent(): void; onInvalidated(callback: () => void): () => void };
  bindNativeWindow?(window: BrowserWindow): Promise<void>;
  createSession(isCurrent: () => boolean, notifyRestorePassword: (value: { requestId: string; challengeId: string; stage: "prepare" | "publish" }) => void,
    notifyAuthenticationPhase: (pending: boolean) => void, invalidateSession: () => void): Session | Promise<Session>;
}): Promise<{ window: BrowserWindow; close(): Promise<void>; isClosing(): boolean }> {
  if (!!input.nativeLifetime === !!input.localLifetime) throw new Error("GENERAL_SECRET_ADMISSION_UNAVAILABLE");
  const lifetime = (input.nativeLifetime ?? input.localLifetime)!;
  const assertNative = (): void => {
    const result: unknown = lifetime.assertCurrent();
    if (result !== undefined) {
      if (result instanceof Promise) void result.catch(() => {});
      throw new Error("GENERAL_SECRET_ADMISSION_UNAVAILABLE");
    }
  };
  assertNative();
  const presentation = async () => {
    const requested = typeof input.locale === "function" ? input.locale() : input.locale;
    const locale = requested === "zh-CN" ? "zh-CN" : "en-US";
    const raw = await readFile(join(input.resourceDirectory, `${locale}.json`));
    if (raw.byteLength > MAX_MESSAGES_BYTES) throw new Error("GENERAL_SETUP_UNAVAILABLE");
    const messages: unknown = JSON.parse(raw.toString("utf8"));
    if (!messages || typeof messages !== "object" || Array.isArray(messages) || Object.entries(messages).some(([key, value]) =>
      !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(key) || typeof value !== "string" || value.length > 2048))
      throw new Error("GENERAL_SETUP_UNAVAILABLE");
    return { locale, messages };
  };
  await presentation();
  assertNative();
  const url = pathToFileURL(join(input.resourceDirectory, "index.html")).href;
  const allowed = new Set(["index.html", "style.css", "setup.js", "accounts.js", "history.js", "manual.js", "backup.js", "restore.js"].map((name) => pathToFileURL(join(input.resourceDirectory, name)).href));
  const win = new BrowserWindow({ width: 620, height: 760, minWidth: 360, minHeight: 480, show: false, title: "Wallet setup",
    webPreferences: { preload: join(input.resourceDirectory, "preload.cjs"), sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true, webviewTag: false, devTools: false, partition: `koincode-protected-general-setup-${randomUUID()}` } });
  let closed = false, closing: Promise<void> | undefined, session: Session | undefined, unsubscribe: (() => void) | undefined;
  let handlerAttached = false, inFlight = 0, sessionCreation: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    let cleanupFailed = false;
    closing = Promise.resolve().then(async () => {
      try {
        await sessionCreation?.catch(() => {});
        await session?.close();
        if (cleanupFailed) throw new Error("GENERAL_SETUP_CLOSE_UNCERTAIN");
      } finally { if (!win.isDestroyed()) win.destroy(); }
    });
    try { unsubscribe?.(); } catch { cleanupFailed = true; }
    if (handlerAttached) { ipcMain.removeHandler(CHANNEL); ipcMain.removeHandler(`${CHANNEL}:copy-mnemonic`); ipcMain.removeListener(`${CHANNEL}:close`, closeRequest); }
    if (!win.isDestroyed()) {
      try { win.webContents.send(`${CHANNEL}:invalidated`); win.hide(); } catch { /* The private renderer may have exited. */ }
    }
    return closing;
  };
  const current = (): boolean => {
    try {
      assertNative();
      return !closed && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.webContents.getURL() === url;
    } catch { return false; }
  };
  const sender = (event: IpcMainInvokeEvent | Electron.IpcMainEvent): void => {
    if (!current() || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame?.url !== url)
      throw new Error("GENERAL_UNTRUSTED_SOURCE");
  };
  const closeRequest = (event: Electron.IpcMainEvent) => {
    try { sender(event); void close().catch(() => {}); } catch { /* No authority is granted to a foreign close request. */ }
  };
  try {
    win.setContentProtection(false);
    const browserSession = win.webContents.session;
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    browserSession.setPermissionCheckHandler(() => false);
    browserSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowed.has(details.url) }));
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.webContents.on("will-attach-webview", (event) => event.preventDefault());
    win.on("close", (event) => { if (!closed) { event.preventDefault(); void close().catch(() => {}); } });
    win.on("closed", () => { void close().catch(() => {}); });
    win.on("hide", () => { void close().catch(() => {}); });
    win.on("minimize", () => { void close().catch(() => {}); });
    win.webContents.on("render-process-gone", () => { void close().catch(() => {}); });
    const createSession = async () => {
      session = await input.createSession(current, (value) => {
        if (!current()) throw new Error("GENERAL_OPERATION_CANCELED");
        assertGeneralRestorePasswordRequest(value);
        win.webContents.send(`${CHANNEL}:restore-password`, value);
      }, (pending) => {
        if (typeof pending !== "boolean" || !current()) throw new Error("GENERAL_OPERATION_CANCELED");
        // Lifecycle notification only. Never an authentication receipt, grant
        // or permission to return material from the protected native scope.
        win.webContents.send(`${CHANNEL}:authentication-phase`, pending);
      }, () => { void close().catch(() => {}); });
    };
    const ensureSession = async () => {
      if (!sessionCreation) sessionCreation = createSession().catch((error) => { sessionCreation = undefined; throw error; });
      await sessionCreation;
      if (!current()) throw new Error("GENERAL_OPERATION_CANCELED");
    };
    if (!input.bindNativeWindow && !(input.localLifetime && input.initialView === "import")) {
      sessionCreation = createSession(); await sessionCreation;
    }
    const subscription: unknown = lifetime.onInvalidated(() => { void close().catch(() => {}); });
    if (typeof subscription !== "function") {
      if (subscription instanceof Promise) void subscription.catch(() => {});
      throw new Error("GENERAL_SECRET_ADMISSION_UNAVAILABLE");
    }
    unsubscribe = subscription as () => void;
    if (closed) throw new Error("GENERAL_OPERATION_CANCELED");
    ipcMain.handle(CHANNEL, async (event, command: unknown) => {
      let timer: ReturnType<typeof setTimeout> | undefined, admitted = false;
      try {
        sender(event);
        if (inFlight >= 2) throw new Error("GENERAL_OPERATION_BUSY");
        let bytes = MAX_COMMAND_BYTES + 1;
        try { bytes = Buffer.byteLength(JSON.stringify(command)); } catch { /* Non-JSON is invalid. */ }
        if (bytes > MAX_COMMAND_BYTES) throw new Error("INVALID_REQUEST");
        inFlight++; admitted = true;
        const bootstrap = command && typeof command === "object" && !Array.isArray(command) &&
          Object.keys(command).join() === "action" && (command as { action?: unknown }).action === "bootstrap";
        const localize = command && typeof command === "object" && !Array.isArray(command) &&
          Object.keys(command).join() === "action" && (command as { action?: unknown }).action === "presentation";
        const work = localize ? presentation() : bootstrap ? presentation().then(copy => ({ ...copy, extendedManagement: input.management === "extended", localManagement: Boolean(input.localLifetime), ...(input.initialView ? { initialView: input.initialView } : {}) })) : ensureSession().then(() => dispatchNamedSetup(command, value => session!.dispatch(value), () => sender(event)));
        const timeout = command && typeof command === "object" && ["backup_export", "restore_prepare", "restore_publish"].includes((command as { action?: unknown }).action as string) ? 180_000 : TIMEOUT_MS;
        const value = await Promise.race([work, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { void close().catch(() => {}); reject(new Error("GENERAL_SETUP_TIMEOUT")); }, timeout);
        })]);
        sender(event);
        if (command && typeof command === "object" && ["reveal_created", "reveal_ready_mnemonic", "export_secret"].includes((command as { action: string }).action) &&
            (!win.isFocused() || !win.webContents.isFocused())) throw new Error("GENERAL_OPERATION_CANCELED");
        if (!bootstrap && !localize) assertGeneralSetupReply((command as { action?: unknown }).action, value, (command as { format?: unknown }).format);
        if (Buffer.byteLength(JSON.stringify(value)) > MAX_REPLY_BYTES) throw new Error("GENERAL_SETUP_UNAVAILABLE");
        return { ok: true, value };
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : error instanceof Error ? error.message : "";
        return { ok: false, code: typeof code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : "GENERAL_SETUP_UNAVAILABLE" };
      } finally {
        if (command && typeof command === "object" && ["backup_export", "restore_password"].includes((command as { action?: unknown }).action as string)) {
          try { (command as { password?: unknown }).password = ""; } catch { /* Clear only this IPC-owned command when writable. */ }
        }
        if (timer) clearTimeout(timer); if (admitted) inFlight--;
      }
    });
    handlerAttached = true;
    ipcMain.handle(`${CHANNEL}:copy-mnemonic`, (event, ...args: unknown[]) => {
      try {
        copyGeneralMnemonic(args.length === 1 ? args[0] : undefined, {
          assertCurrent: () => {
            sender(event);
            if (inFlight !== 0 || !win.isFocused() || !win.webContents.isFocused()) throw new Error("GENERAL_UNTRUSTED_SOURCE");
          },
          writeText: (phrase) => (input.clipboard ?? clipboard).writeText(phrase),
        });
        return { ok: true };
      } catch { return { ok: false, code: "GENERAL_COPY_FAILED" }; }
      finally { args.fill(""); }
    });
    ipcMain.on(`${CHANNEL}:close`, closeRequest);
    await win.loadURL(url);
    assertNative();
    if (closed) throw new Error("GENERAL_OPERATION_CANCELED");
    win.show();
    if (input.bindNativeWindow) { await input.bindNativeWindow(win); sessionCreation = createSession(); await sessionCreation; }
    if (closed) throw new Error("GENERAL_OPERATION_CANCELED");
    win.webContents.send(`${CHANNEL}:ready`);
    return { window: win, close, isClosing: () => closed };
  } catch (error) { await close(); throw error; }
}
