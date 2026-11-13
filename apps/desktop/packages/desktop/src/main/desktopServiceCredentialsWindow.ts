import { BrowserWindow, ipcMain } from "electron";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ServiceCredentialStore } from "./desktopServiceCredentials.js";

const CHANNEL = "koincode:service-credentials-window";
type Options = {
  resourceDirectory: string;
  store: ServiceCredentialStore;
  locale: () => string;
  enterSensitiveUi: () => Promise<() => void>;
  observeApplicationHide: (onHide: () => void) => { hidden(): boolean; dispose(): void };
  initializeHistory?: (assertCurrent: () => void) => Promise<void>;
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));

/** This control plane is separate from wallet management and never exposes secret reads. */
export function createServiceCredentialsWindow(options: Options) {
  const directory = options.resourceDirectory;
  const page = pathToFileURL(join(directory, "index.html")).href;
  const allowed = new Set(["index.html", "settings.js", "style.css", "en-US.json", "zh-CN.json"]
    .map((name) => pathToFileURL(join(directory, name)).href));
  let current: BrowserWindow | undefined;
  let opening: Promise<void> | undefined;
  let disposed = false;
  let busy = false;
  let epoch = 0;
  const application = options.observeApplicationHide(() => {
    epoch++;
    if (current && !current.isDestroyed()) current.destroy();
  });
  function assertCurrent(win: BrowserWindow, generation: number): void {
    if (disposed || epoch !== generation || current !== win || win.isDestroyed() ||
        !win.isVisible() || win.isMinimized() || application.hidden() || win.webContents.mainFrame.url !== page)
      throw Object.assign(new Error("SERVICE_UNTRUSTED_SOURCE"), { code: "SERVICE_UNTRUSTED_SOURCE" });
  }

  ipcMain.handle(CHANNEL, async (event, input: unknown) => {
    const win = current;
    if (disposed || !win || win.isDestroyed() || !win.isVisible() || win.isMinimized() ||
        event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame ||
        event.senderFrame?.url !== page) return { ok: false, code: "SERVICE_UNTRUSTED_SOURCE" };
    if (!record(input) || Buffer.byteLength(JSON.stringify(input)) > 16 * 1024 || busy)
      return { ok: false, code: "SERVICE_INVALID_REQUEST" };
    const generation = epoch;
    const guard = () => assertCurrent(win, generation);
    busy = true;
    try {
      guard();
      if (input.action === "status" && keys(input, ["action"])) {
        const locale = options.locale() === "zh-CN" ? "zh-CN" : "en-US";
        const messages: unknown = JSON.parse(await readFile(join(directory, `${locale}.json`), "utf8"));
        if (!record(messages) || Object.values(messages).some((value) => typeof value !== "string" || value.length > 2048))
          throw new Error("SERVICE_CREDENTIALS_UNAVAILABLE");
        let entries;
        try { entries = await options.store.list(); guard(); }
        catch { return { ok: false, code: "SERVICE_CREDENTIALS_UNAVAILABLE", value: { locale, messages } }; }
        return { ok: true, value: { entries, locale, messages } };
      }
      if (input.action === "save" && keys(input, ["action", "origin", "path", "secret", "ref"]) &&
          typeof input.origin === "string" && typeof input.path === "string" && typeof input.secret === "string" &&
          (input.ref === undefined || typeof input.ref === "string")) {
        await options.initializeHistory?.(guard);
        guard();
        const value = await options.store.save({ origin: input.origin, path: input.path, secret: input.secret,
          ...(input.ref ? { ref: input.ref } : {}) }, guard);
        guard();
        return { ok: true, value };
      }
      if (input.action === "revoke" && keys(input, ["action", "ref"]) && typeof input.ref === "string") {
        await options.store.revoke(input.ref, guard);
        guard();
        return { ok: true };
      }
      return { ok: false, code: "SERVICE_INVALID_REQUEST" };
    } catch (error) {
      const code = record(error) && typeof error.code === "string" && /^SERVICE_[A-Z_]+$/.test(error.code)
        ? error.code : "SERVICE_CREDENTIALS_UNAVAILABLE";
      return { ok: false, code };
    } finally { busy = false; }
  });

  async function show(): Promise<void> {
    if (disposed || application.hidden()) throw new Error("SERVICE_CREDENTIALS_UNAVAILABLE");
    if (current && !current.isDestroyed()) {
      if (current.isVisible() && !current.isMinimized()) { current.focus(); return; }
      epoch++; current.destroy();
    }
    if (opening) return opening;
    const generation = epoch;
    opening = (async () => {
      const release = await options.enterSensitiveUi();
      let released = false;
      const releaseOnce = () => { if (!released) { released = true; release(); } };
      let win: BrowserWindow | undefined;
      try {
        if (disposed || epoch !== generation || application.hidden()) throw new Error("SERVICE_CREDENTIALS_UNAVAILABLE");
        win = new BrowserWindow({ width: 640, height: 600, minWidth: 360, minHeight: 400, show: false,
          title: "Service credentials", webPreferences: { preload: join(directory, "preload.cjs"), sandbox: true,
            contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false,
            partition: "koincode-service-credentials" } });
        current = win;
        win.setContentProtection(true);
        win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        win.webContents.session.setPermissionCheckHandler(() => false);
        win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allowed.has(details.url) }));
        win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
        win.webContents.on("will-navigate", (event) => event.preventDefault());
        win.webContents.on("will-attach-webview", (event) => event.preventDefault());
        const retire = () => { if (current === win) { epoch++; if (!win!.isDestroyed()) win!.destroy(); } };
        win.webContents.on("render-process-gone", retire);
        win.on("hide", retire);
        win.on("minimize", retire);
        win.on("close", () => { if (current === win) epoch++; });
        win.once("closed", () => { if (current === win) current = undefined; releaseOnce(); });
        win.show();
        await win.loadFile(join(directory, "index.html"));
        assertCurrent(win, generation);
        win.focus();
      } catch (error) {
        if (win && !win.isDestroyed()) win.destroy();
        if (current === win) current = undefined;
        releaseOnce();
        throw error;
      }
    })().finally(() => { opening = undefined; });
    return opening;
  }
  return { show, ownsWindow: (win: BrowserWindow) => current === win,
    dispose: () => { disposed = true; epoch++; application.dispose(); ipcMain.removeHandler(CHANNEL);
      if (current && !current.isDestroyed()) current.destroy(); current = undefined; } };
}
