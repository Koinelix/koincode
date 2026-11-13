import type { BrowserWindow } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DesktopWalletWindowOptions } from "./desktopWalletWindowPolicy.js";
import type { DesktopWalletInteraction } from "./desktopWalletInteraction.js";
import { attachWalletPaymentWindow } from "./desktopWalletPaymentWindow.js";
import { createWalletBrowserWindow, readWalletMessages } from "./desktopWalletWindowResources.js";

interface PromptOptions {
  host: DesktopWalletWindowOptions;
  applicationHidden(): boolean;
  busy: Map<BrowserWindow, string>;
  observations: Map<BrowserWindow, DesktopWalletInteraction>;
  interruptGeneralConfirmation(): void;
}

/** Independent presentation only; the original broker and wallet still own every payment. */
export function createDesktopWalletPaymentPrompt(options: PromptOptions) {
  const { host, busy, observations } = options;
  const pagePath = join(host.resourceDirectory, "payment.html"), expectedUrl = pathToFileURL(pagePath).href;
  let current: BrowserWindow | undefined, opening: Promise<void> | undefined;
  let epoch = 0, disposed = false, invalidating = false;
  const live = (window: BrowserWindow, generation: number) => !disposed && !options.applicationHidden() &&
    current === window && epoch === generation && !window.isDestroyed() && !window.webContents.isDestroyed() &&
    window.isVisible() && !window.isMinimized();
  const assertCurrent = (window: BrowserWindow, generation: number) => {
    if (!live(window, generation)) throw new Error("WALLET_INTERACTION_CANCELED");
  };
  function invalidate(global = false) {
    if (invalidating || (disposed && !current && !opening)) return;
    invalidating = true; epoch++;
    try {
      const win = current;
      const ownsInteraction = !!win && (busy.has(win) || observations.has(win));
      current = undefined;
      if (win) observations.get(win)?.cancel();
      try {
        if (global || ownsInteraction) {
          try { host.cancelAuthentication(); }
          finally { host.wallet.cancelHostInteraction(); }
        } else {
          for (const notice of host.paymentBroker?.list() ?? [])
            void host.paymentBroker!.decide(notice.approvalId, "deny").catch(() => {});
        }
      } finally { if (win && !win.isDestroyed()) win.destroy(); }
    } catch { throw new Error("WALLET_INTERACTION_UNCERTAIN"); }
    finally { invalidating = false; }
  }
  function dismiss() {
    const win = current;
    if (!win || opening || busy.has(win) || observations.has(win) || host.paymentBroker?.list().length) return;
    current = undefined; epoch++;
    if (!win.isDestroyed()) win.destroy();
  }
  function show(): Promise<void> {
    if (disposed || options.applicationHidden()) return Promise.reject(new Error("WALLET_INTERACTION_CANCELED"));
    if (current && !current.isDestroyed() && current.isVisible() && !current.isMinimized()) { current.focus(); return Promise.resolve(); }
    if (opening) return opening;
    const generation = epoch;
    opening = (async () => {
      const release = await host.enterSensitiveUi();
      let released = false;
      const releaseOnce = () => { if (!released) { released = true; release(); } };
      let win: BrowserWindow | undefined;
      try {
        if (disposed || epoch !== generation || options.applicationHidden()) throw new Error("WALLET_INTERACTION_CANCELED");
        win = createWalletBrowserWindow(host.resourceDirectory, true); current = win;
        const cancel = () => { if (current === win) invalidate(); };
        win.on("close", cancel); win.on("hide", cancel); win.on("minimize", cancel);
        win.webContents.on("render-process-gone", cancel); win.webContents.on("destroyed", cancel);
        win.once("closed", () => {
          if (current === win) { current = undefined; epoch++; }
          observations.get(win!)?.cancel(); observations.delete(win!); releaseOnce();
        });
        await win.loadFile(pagePath);
        if (disposed || current !== win || win.isDestroyed() || epoch !== generation || options.applicationHidden())
          throw new Error("WALLET_INTERACTION_CANCELED");
        if (!host.paymentBroker?.list().length) { current = undefined; epoch++; win.destroy(); return; }
        win.show(); win.focus(); win.webContents.send("koincode:trusted-wallet-payment-changed");
      } catch (error) {
        if (current === win) current = undefined;
        if (win && !win.isDestroyed()) win.destroy();
        releaseOnce(); throw error;
      }
    })().finally(() => { opening = undefined; dismiss(); });
    return opening;
  }
  const disposeHandler = attachWalletPaymentWindow({ host, expectedUrl, current: () => disposed ? undefined : current,
    epoch: () => epoch, assertCurrent, show, invalidate,
    messages: () => readWalletMessages(host.resourceDirectory, host.locale()), busy, observations,
    interruptGeneralConfirmation: options.interruptGeneralConfirmation, dismissEmpty: dismiss, dismissSettled: dismiss });
  return {
    ownsWindow: (window: BrowserWindow) => current === window,
    close() { if (current || opening) invalidate(true); },
    stateInvalidated(reason: string) {
      if (["exited", "startup_failed", "lock_requested", "interaction_canceled"].includes(reason) && (current || opening)) invalidate();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try { if (current || opening) invalidate(); } finally { disposeHandler(); }
    },
  };
}
