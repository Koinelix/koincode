import { ipcMain, type BrowserWindow } from "electron";
import { walletPaymentWindowCommandSchema } from "@fcode/shared";
import type { DesktopWalletWindowOptions } from "./desktopWalletWindowPolicy.js";
import { isTrustedWalletSender, walletWindowError } from "./desktopWalletWindowPolicy.js";
import { DesktopWalletInteraction } from "./desktopWalletInteraction.js";

const CHANNEL = "koincode:trusted-wallet-payment";
const CHANGED = "koincode:trusted-wallet-payment-changed";
type Options = {
  host: DesktopWalletWindowOptions;
  expectedUrl: string;
  current(): BrowserWindow | undefined;
  epoch(): number;
  assertCurrent(window: BrowserWindow, epoch: number): void;
  show(): Promise<void>;
  invalidate(): void;
  dismissApproved?(window: BrowserWindow): void;
  dismissSettled?(window: BrowserWindow): void;
  dismissEmpty?(): void;
  messages(): Promise<Record<string, string>>;
  busy: Map<BrowserWindow, string>;
  observations: Map<BrowserWindow, DesktopWalletInteraction>;
  interruptGeneralConfirmation?: () => void;
};

/** Shares the wallet window's identity, visibility and exclusive authentication gate. */
export function attachWalletPaymentWindow(options: Options): () => void {
  const broker = options.host.paymentBroker;
  let active: { id: string; submitted: boolean; observation: DesktopWalletInteraction } | undefined;
  const notify = () => {
    const views = broker?.list() ?? [];
    if (views.length) { try { options.interruptGeneralConfirmation?.(); } catch { /* Keep the original presenter independent. */ } }
    if (active && !active.submitted && !views.some((v) => v.approvalId === active!.id))
      active.observation.cancel();
    if (!views.length && !active) options.dismissEmpty?.();
    const win = options.current();
    if (win && !win.isDestroyed() && win.webContents.isDestroyed()) return;
    if (views.length && (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized() || !win.isFocused())) {
      void options
        .show()
        .then(() => {
          const current = options.current();
          if (current && !current.isDestroyed() && !current.webContents.isDestroyed()) current.webContents.send(CHANGED);
        })
        .catch(() => {
          try {
            options.invalidate();
          } catch {
            /* The window epoch already fences the request. */
          }
        });
    } else if (win && !win.isDestroyed()) win.webContents.send(CHANGED);
  };
  let unsubscribe = () => {};
  let registered = false;
  try {
    unsubscribe = broker?.subscribe(notify) ?? unsubscribe;
    ipcMain.handle(CHANNEL, async (event, raw: unknown) => {
      try {
        const win = options.current();
        if (!win || win.isDestroyed()) throw new Error("WALLET_UNTRUSTED_SOURCE");
        const epoch = options.epoch();
        options.assertCurrent(win, epoch);
        if (
          !isTrustedWalletSender({
            sender: event.sender,
            expectedSender: win.webContents,
            frame: event.senderFrame,
            mainFrame: win.webContents.mainFrame,
            frameUrl: event.senderFrame?.url,
            expectedUrl: options.expectedUrl,
            visible: win.isVisible() && !win.isMinimized(),
          })
        )
          throw new Error("WALLET_UNTRUSTED_SOURCE");
        if (!raw || Buffer.byteLength(JSON.stringify(raw)) > 2048)
          throw new Error("WALLET_INVALID_REQUEST");
        const command = walletPaymentWindowCommandSchema.parse(raw);
        if (command.action === "payment_presentation") return { ok: true, value: { text: await options.messages() } };
        if (command.action === "payment_status") return { ok: true, value: broker?.list() ?? [] };
        console.info("[wallet-payment] Decision received.");
        if (
          !broker ||
          !broker.list().some((v) => v.approvalId === command.approvalId && v.expiresInMs > 0)
        )
          throw new Error("PAYMENT_APPROVAL_UNAVAILABLE");
        if (options.busy.size) throw new Error("WALLET_BUSY");
        options.busy.set(win, "payment_decide");
        const observation = new DesktopWalletInteraction(() => {
          try {
            options.assertCurrent(win, epoch);
            return true;
          } catch {
            return false;
          }
        }, options.invalidate);
        options.observations.set(win, observation);
        const attempt = { id: command.approvalId, submitted: false, observation };
        active = attempt;
        const work = (async () => {
          let authenticated = false;
          try {
            const payment = broker.list().find(v => v.approvalId === command.approvalId);
            if (command.choice !== "deny" && payment?.wallet.locked) {
              const text = await options.messages();
              options.assertCurrent(win, epoch);
              const reason = text.paymentAuthReason ?? text.authReason;
              if (typeof reason !== "string" || reason.length > 2048)
                throw new Error("WALLET_UNAVAILABLE");
              await options.host.authenticate(reason);
              authenticated = true;
            }
            options.assertCurrent(win, epoch);
            if (
              !broker.list().some((v) => v.approvalId === command.approvalId && v.expiresInMs > 0)
            )
              throw new Error("QUOTE_EXPIRED");
            attempt.submitted = true;
            console.info("[wallet-payment] Decision submission started.");
            if (!(await broker.decide(command.approvalId, command.choice, authenticated)))
              throw new Error("PAYMENT_APPROVAL_UNAVAILABLE");
            console.info("[wallet-payment] Decision submission completed.");
            options.assertCurrent(win, epoch);
            return { ok: true, value: null };
          } finally {
            if (options.busy.get(win) === "payment_decide") options.busy.delete(win);
            if (active === attempt) active = undefined;
          }
        })();
        let approved = false, settled = false;
        try {
          const result = await Promise.race([work, observation.canceled]);
          settled = result.ok; approved = result.ok && command.choice !== "deny";
          return result;
        } finally {
          observation.stop();
          if (options.observations.get(win) === observation) options.observations.delete(win);
          if (approved) options.dismissApproved?.(win);
          if (settled) options.dismissSettled?.(win);
        }
      } catch (failure) {
        const code = walletWindowError(failure);
        console.info("[wallet-payment] Control request failed:", code);
        return { ok: false, error: code };
      }
    });
    registered = true;
    if (broker?.list().length) notify();
  } catch (failure) {
    unsubscribe();
    if (registered) ipcMain.removeHandler(CHANNEL);
    throw failure;
  }
  return () => {
    active?.observation.cancel();
    unsubscribe();
    if (registered) {
      registered = false;
      ipcMain.removeHandler(CHANNEL);
    }
  };
}
