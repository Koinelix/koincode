import { attachWalletAccountNames } from "./desktopWalletAccountNames.js";
import { createAllowanceHandler } from "./desktopWalletAllowance.js";
import { parseAllowanceCommand } from "./desktopWalletProtocol.js";
import { invalidateWalletPresentation } from "./desktopWalletPresentationLifetime.js";
import { desktopPaymentNetwork } from "../wallet/paymentNetwork.js";
import { ipcMain, type BrowserWindow } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DesktopWalletDisplayExpiry } from "./desktopWalletDisplayExpiry.js";
import { DesktopWalletInteraction } from "./desktopWalletInteraction.js";
import { DesktopLegacyAccountSnapshot } from "./desktopLegacyAccountSnapshot.js";
import { inspectWalletSettings, applyWalletSettings } from "./desktopWalletSettings.js";
import { createDesktopWalletPaymentPrompt } from "./desktopWalletPaymentPrompt.js";
import { attachWalletOutboundDialogs } from "./desktopWalletOutboundDialogs.js";
import { openWalletForDisplay } from "./desktopWalletWindowStartup.js";
import { createWalletResponseDestinationPicker } from "./desktopWalletResponseDestination.js";
import { attachDesktopGeneralWalletWindow } from "./desktopGeneralWalletWindow.js";
import { createDesktopGeneralConfirmationGate } from "./desktopGeneralConfirmationGate.js";
import {
  assertWalletWindowSender,
  parseWalletWindowCommand,
  walletWindowItems,
  walletWindowError,
  walletControlBusy,
  walletCommandRequiresAuthentication,
  type DesktopWalletWindowOptions,
} from "./desktopWalletWindowPolicy.js";

import { confirmWalletWindowAction, createWalletBrowserWindow, readWalletMessages, readWalletPresentation, runWalletCleanup } from "./desktopWalletWindowResources.js";

const CHANNEL = "koincode:trusted-wallet-window";
const READY = "koincode:trusted-wallet-ready";
const INVALIDATED = "koincode:trusted-wallet-state-invalidated";

/** A separate local renderer; the ordinary chat renderer never receives management capabilities. */
export function createDesktopWalletWindow(options: DesktopWalletWindowOptions) {
  const pagePath = join(options.resourceDirectory, "index.html");
  const expectedUrl = pathToFileURL(pagePath).href;
  let current: BrowserWindow | undefined;
  let opening: Promise<void> | undefined;
  const expiry = new DesktopWalletDisplayExpiry();
  let statusSequence = 0;
  let profileOpen = false, profileCreatedNeedsOpen = false;
  let startupError: string | undefined;
  let setupRequired = false;
  let disposed = false, visibilityUncertain = false;
  let epoch = 0;
  let applicationEpoch = 0;
  const legacySnapshot = new DesktopLegacyAccountSnapshot();
  const busy = new Map<BrowserWindow, string>();
  const observations = new Map<BrowserWindow, DesktopWalletInteraction>();
  const generalConfirmation = createDesktopGeneralConfirmationGate(options, busy);

  let paymentPrompt: ReturnType<typeof createDesktopWalletPaymentPrompt> | undefined;
  const invalidate = () => invalidateWalletPresentation({ ...options,
    cancelAuthentication: () => { if (!busy.size || (current && busy.has(current))) options.cancelAuthentication(); } }, () => epoch++,
    Boolean(current && !visibilityUncertain && !opening && !busy.has(current) && !observations.has(current) &&
      !options.outboundBroker?.hasPending()));

  function retire(window: BrowserWindow): void {
    if (current !== window) return;
    legacySnapshot.clear(); expiry.cancel();
    statusSequence++;
    try {
      invalidate();
    } finally {
      if (!window.isDestroyed()) window.destroy();
    }
  }

  const application = options.observeApplicationHide(() => {
    if (disposed) return;
    applicationEpoch++;
    try { paymentPrompt?.close(); }
    finally { if (current) retire(current); else if (opening) invalidate(); }
  });
  function applicationHidden(): boolean {
    try {
      return application.hidden();
    } catch {
      visibilityUncertain = true;
      return true;
    }
  }
  const subscribeState = () => options.wallet.onStateInvalidated((reason) => {
    paymentPrompt?.stateInvalidated(reason);
    legacySnapshot.clear();
    expiry.cancel();
    statusSequence++;
    if (reason === "profile_opened") { profileOpen = true; setupRequired = false; startupError = undefined; profileCreatedNeedsOpen = false; }
    if (reason === "exited" || reason === "startup_failed" || reason === "maintenance_finished") profileOpen = false;
    if (reason === "exited" || reason === "lock_requested" || reason === "interaction_canceled") {
      epoch++;
      try {
        options.cancelAuthentication();
      } catch {
        /* The epoch still fences pending work. */
      }
    }
    if (current && !current.isDestroyed() && !current.webContents.isDestroyed() && current.isVisible() && !current.isMinimized()) {
      // After a first-run open finds no profile, the wallet utility is retired on purpose.
      // That expected teardown is reported as guided setup, never as a lost service.
      const expectedTeardown = setupRequired && !profileOpen && (reason === "exited" || reason === "lock_requested");
      current.webContents.send(INVALIDATED, expectedTeardown ? "setup_required" : reason);
    }
  });

  function checkVisibility(window: BrowserWindow): void {
    if (
      current === window &&
      !window.isDestroyed() &&
      (applicationHidden() || (!window.isVisible() && !window.isMinimized()))
    ) {
      retire(window);
    }
    if (current === window && !window.isDestroyed() && window.isMinimized()) invalidate();
  }

  function assertCurrent(window: BrowserWindow, generation: number): void {
    checkVisibility(window);
    if (!isCurrent(window, generation)) throw new Error("WALLET_INTERACTION_CANCELED");
  }

  function isCurrent(window: BrowserWindow, generation: number): boolean {
    return !disposed && !applicationHidden() && current === window && !window.isDestroyed() && !window.webContents.isDestroyed() &&
      window.isVisible() && !window.isMinimized() && epoch === generation;
  }


  const messages = () => readWalletMessages(options.resourceDirectory, options.locale()); const handleAllowance = createAllowanceHandler(options, messages, assertCurrent, busy);

  let unsubscribeState = () => {}, disposePayments = () => {}; let disposeOutbound = () => {}, disposeGeneral = () => {}, disposeNames = () => {};
  try {
    unsubscribeState = subscribeState();
    disposeNames = attachWalletAccountNames({ expectedUrl, current: () => disposed ? undefined : current, epoch: () => epoch, assertCurrent, wallets: async () => profileOpen ? walletWindowItems(await options.wallet.list()) : [] });
    paymentPrompt = createDesktopWalletPaymentPrompt({ host: options, applicationHidden, busy, observations,
      interruptGeneralConfirmation: generalConfirmation.interrupt });
    disposePayments = () => paymentPrompt?.dispose();
    disposeOutbound = attachWalletOutboundDialogs({ host: options, current: () => disposed ? undefined : current,
      epoch: () => epoch, assertCurrent, show, invalidate, messages, busy, observations, interruptGeneralConfirmation: generalConfirmation.interrupt });
    try {
      const generalHost: DesktopWalletWindowOptions = { ...options, confirmGeneralRpc: generalConfirmation.confirm };
      disposeGeneral = attachDesktopGeneralWalletWindow({ host: generalHost, expectedUrl,
        current: () => disposed ? undefined : current, epoch: () => epoch, isCurrent, isBusy: window => busy.has(window),
        legacyAccounts: (window, generation, stateGeneration) => legacySnapshot.read(window, generation, stateGeneration,
          statusSequence, profileOpen && isCurrent(window, generation)) });
    } catch { /* An unavailable new view must not prevent the legacy wallet opening. */ }
    ipcMain.handle(CHANNEL, async (event, raw: unknown) => {
      const win = current;
      let observedEpoch: number | undefined;
      try {
        if (win) checkVisibility(win);
        assertWalletWindowSender(win, event, expectedUrl, applicationHidden);
        if (typeof raw !== "object" || raw === null || Buffer.byteLength(JSON.stringify(raw)) > 2048)
          throw new Error("WALLET_INVALID_REQUEST");
        const allowance = parseAllowanceCommand(raw);
        if (allowance) {
          return await handleAllowance(allowance, win, epoch, profileOpen);
        }
        const command = parseWalletWindowCommand(raw);
        if (!command) throw new Error("WALLET_INVALID_REQUEST");
        const generation = epoch;
        observedEpoch = generation;
        if (command.action === "inspect_wallet") {
          const observation = options.wallet.stateGeneration();
          const value = await inspectWalletSettings(options.wallet, command);
          assertCurrent(win, generation);
          if (options.wallet.stateGeneration() !== observation) throw new Error("WALLET_STATE_INVALIDATED");
          return { ok: true, value };
        }
        if (command.action === "presentation") return { ok: true, value: await readWalletPresentation(options.resourceDirectory, options.locale(), () => assertCurrent(win, generation)) };
        if (command.action === "status") {
          const sequence = ++statusSequence;
          legacySnapshot.clear();
          const startedAt = performance.now();
          const observation = options.wallet.stateGeneration();
          const text = await messages();
          const wallets = profileOpen ? walletWindowItems(await options.wallet.list()) : [];
          assertCurrent(win, generation);
          if (options.wallet.stateGeneration() !== observation || statusSequence !== sequence)
            throw new Error("WALLET_STATE_INVALIDATED");
          if (!expiry.replaceForWallets(startedAt, wallets,
            () => isCurrent(win, generation) && options.wallet.stateGeneration() === observation,
            () => options.wallet.invalidateDisplayObservation()))
            throw new Error("WALLET_STATE_INVALIDATED");
          if (profileOpen) legacySnapshot.publish(win, generation, observation, sequence, wallets);
          return { ok: true, value: { text, network: desktopPaymentNetwork().network, profileOpen, loading: Boolean(opening), profileCreatedNeedsOpen, wallets, ...(setupRequired && !profileOpen ? { setupRequired: true } : {}), ...(startupError ? { startupError } : {}) } };
        }
        if (command.action === "lock") {
          await options.wallet.manage({ action: "lock", walletId: command.walletId });
          return { ok: true, value: null };
        }
        if (walletControlBusy(busy, win, command.action)) {
          throw new Error("WALLET_BUSY");
        }
        busy.set(win, command.action);
        const observation = new DesktopWalletInteraction(
          () => isCurrent(win, generation),
          () => {
            if (current === win && !win.isDestroyed() && win.isMinimized()) invalidate();
            else retire(win);
          },
        );
        observations.set(win, observation);
        const work = (async () => {
          try {
            if (command.action === "open_profile") {
              if (!profileOpen) await options.wallet.start("open");
              assertCurrent(win, generation);
              profileOpen = true;
              startupError = undefined;
              setupRequired = false;
              profileCreatedNeedsOpen = false;
            } else {
              const text = await messages();
              assertCurrent(win, generation);
              if (command.action === "create_profile") {
                if (profileOpen || profileCreatedNeedsOpen) throw new Error("WALLET_ALREADY_OPEN");
                const approved = await confirmWalletWindowAction(win, text, true);
                assertCurrent(win, generation);
                if (!approved) throw new Error("WALLET_INTERACTION_CANCELED");
              }
              if (command.action === "register_client" && command.kind === "external") {
                const approved = await confirmWalletWindowAction(win, text, false);
                assertCurrent(win, generation);
                if (!approved) throw new Error("WALLET_INTERACTION_CANCELED");
              }
              if (walletCommandRequiresAuthentication(command.action)) await options.authenticate(text.authReason);
              assertCurrent(win, generation);
              if (command.action === "create_profile") {
                await options.wallet.start("create");
                try {
                  assertCurrent(win, generation);
                } catch {
                  if (!profileOpen && !disposed) {
                    profileCreatedNeedsOpen = true;
                    statusSequence++;
                    if (
                      current &&
                      !current.isDestroyed() &&
                      current.isVisible() &&
                      !current.isMinimized()
                    )
                      current.webContents.send(INVALIDATED, "profile_created");
                  }
                  throw new Error("WALLET_PROFILE_CREATED_REOPEN_REQUIRED");
                }
                profileOpen = true;
                startupError = undefined;
                setupRequired = false;
                profileCreatedNeedsOpen = false;
              } else if (command.action === "create_wallet") {
                await options.wallet.manage({ action: "create", network: desktopPaymentNetwork().network });
                await options.connectDesktop?.();
              } else if (command.action === "set_default") {
                await options.wallet.manage({ action: "default", walletId: command.walletId });
              } else if (command.action === "unlock") {
                await options.wallet.manage({ action: "unlock", walletId: command.walletId, scope: "application" });
              } else {
                await applyWalletSettings(options.wallet, command, () => assertCurrent(win, generation), options.selectClient);
              }
              assertCurrent(win, generation);
            }
            return { ok: true, value: null };
          } finally {
            try {
              checkVisibility(win);
            } finally {
              busy.delete(win);
            }
          }
        })();
        try {
          return await Promise.race([work, observation.canceled]);
        } finally {
          observation.stop();
          if (observations.get(win) === observation) observations.delete(win);
        }
      } catch (error) {
        const code = walletWindowError(error);
        if (
          observedEpoch === epoch &&
          ["WALLET_NOT_OPEN", "WALLET_PROCESS_EXITED", "WALLET_TIMEOUT"].includes(code)
        )
          profileOpen = false;
        return { ok: false, error: code };
      }
    });
  } catch {
    runWalletCleanup([unsubscribeState, disposeNames, disposePayments, disposeOutbound, disposeGeneral, () => application.dispose()]);
    throw new Error("WALLET_WINDOW_UNAVAILABLE");
  }


  async function show(): Promise<void> {
    if (disposed) throw new Error("WALLET_WINDOW_DISPOSED");
    if (applicationHidden()) {
      if (current) retire(current);
      throw new Error("WALLET_INTERACTION_CANCELED");
    }
    if (current && !current.isDestroyed()) {
      if (current.isMinimized()) {
        invalidate();
        current.restore();
        current.focus();
        return;
      } else if (!current.isVisible()) {
        retire(current);
      } else {
        current.focus();
        return;
      }
    }
    if (opening) return opening;
    const openingEpoch = applicationEpoch;
    opening = (async () => {
      const acquired = await options.enterSensitiveUi();
      if (disposed || applicationEpoch !== openingEpoch) {
        acquired();
        throw new Error("WALLET_INTERACTION_CANCELED");
      }
      let released = false;
      const releaseOnce = () => {
        if (!released) {
          released = true;
          acquired();
        }
      };
      let win: BrowserWindow | undefined;
      try {
        if (applicationHidden()) throw new Error("WALLET_INTERACTION_CANCELED");
        win = createWalletBrowserWindow(options.resourceDirectory);
        current = win;
        win.webContents.on("render-process-gone", () => {
          if (current !== win) return;
          try { options.wallet.cancelHostInteraction(); }
          finally { if (win) retire(win); }
        });
        const invalidateCurrent = () => {
          if (current !== win) return;
          expiry.cancel(); statusSequence++;
          invalidate();
        };
        win.webContents.on("destroyed", invalidateCurrent);
        win.on("close", invalidateCurrent);
        win.on("minimize", invalidateCurrent);
        win.on("hide", () => { if (win) retire(win); });
        win.on("restore", () => {
          if (!win || current !== win || win.isDestroyed()) return;
          options.wallet.invalidateDisplayObservation();
        });
        win.once("closed", () => {
          observations.get(win!)?.cancel();
          observations.delete(win!);
          try {
            if (current === win) {
              try { options.generalWallet?.stop(); } catch { /* New-domain failure cannot skip legacy cleanup. */ }
              legacySnapshot.clear();
              expiry.cancel();
              statusSequence++;
              invalidate();
              current = undefined;
            }
          } finally {
            releaseOnce();
          }
        });
        await win.loadFile(pagePath);
        if (disposed || applicationHidden() || applicationEpoch !== openingEpoch || win.isDestroyed() || current !== win)
          throw new Error("WALLET_INTERACTION_CANCELED");
        win.show(); win.focus(); win.webContents.send(READY); console.info("[wallet-window] Wallet window is visible.");
        if (options.autoOpenExisting && !profileOpen && !profileCreatedNeedsOpen)
          ({ profileOpen, startupError, setupRequired = false } = await openWalletForDisplay(options.wallet));
        // The retiring utility may already have announced its lock before the absent profile was known.
        if (setupRequired && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(INVALIDATED, "setup_required");
        if (profileOpen && options.connectDesktop && walletWindowItems(await options.wallet.list()).length) {
          try { await options.connectDesktop(); } catch (error) { startupError = walletWindowError(error); }
        }
        if (disposed || applicationHidden() || applicationEpoch !== openingEpoch || win.isDestroyed() || current !== win)
          throw new Error("WALLET_INTERACTION_CANCELED");
      } catch (error) {
        if (win && !win.isDestroyed()) win.destroy();
        if (current === win) current = undefined;
        releaseOnce();
        throw error;
      }
    })().finally(() => {
      opening = undefined;
      if (current && !current.isDestroyed() && current.isVisible()) current.webContents.send(READY);
    });
    return opening;
  }

  return {
    chooseResponseDestination: createWalletResponseDestinationPicker({ host: options, current: () => current,
      epoch: () => epoch, assertCurrent, show, retire, messages, busy, observations }),
    ownsWindow(window: BrowserWindow): boolean { return current === window || paymentPrompt?.ownsWindow(window) === true; },
    show,
    close: () => { if (current) retire(current); },
    lockForHostEvent: () => options.wallet.lockForHostEvent(),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const observation of observations.values()) observation.cancel();
      observations.clear();
      expiry.cancel();
      statusSequence++;
      runWalletCleanup([
        () => application.dispose(),
        () => options.wallet.lockForHostEvent(),
        () => current?.destroy(),
        unsubscribeState,
        disposeNames, disposePayments,
        disposeOutbound,
        disposeGeneral,
        () => ipcMain.removeHandler(CHANNEL),
      ]);
    },
  };
}
