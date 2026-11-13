import { dialog, ipcMain, type BrowserWindow } from "electron";
import { dirname, join } from "node:path";
import { createGeneralSetupWindow } from "../general-wallet/setupWindow.js";
import { readWalletMessages } from "./desktopWalletWindowResources.js";
import { createLocalManagementSession } from "../general-wallet/localSession.js";
import { isTrustedWalletSender, walletWindowError, type DesktopWalletWindowOptions } from "./desktopWalletWindowPolicy.js";

const CHANNEL = "koincode:wallet-manager-window";
type Input = { host: DesktopWalletWindowOptions; expectedUrl: string; current(): BrowserWindow | undefined; epoch(): number;
  isCurrent(window: BrowserWindow, generation: number): boolean; isBusy?(window: BrowserWindow): boolean };

/** The existing utility owns all secrets; Main owns only this actual private window and operation approval. */
export function attachDesktopWalletManagerWindow(input: Input): () => void {
  let disposed = false, opening = false;
  let maintenanceAbort: AbortController | undefined;
  let owner: { parent: BrowserWindow; manager: Awaited<ReturnType<typeof createGeneralSetupWindow>>; closing?: Promise<void> } | undefined;
  const retire = (item: NonNullable<typeof owner>) => {
    item.closing ??= item.manager.close();
    void item.closing.then(() => { if (owner === item) owner = undefined; }, () => {
      // An uncertain utility close must not be replaced by another secret owner.
    });
  };
  ipcMain.handle(CHANNEL, async (event, value: unknown) => {
    const parent = input.current(), generation = input.epoch();
    try {
      if (disposed || !parent || !input.isCurrent(parent, generation) || !isTrustedWalletSender({
        sender: event.sender, expectedSender: parent.webContents, frame: event.senderFrame,
        mainFrame: parent.webContents.mainFrame, frameUrl: event.senderFrame?.url, expectedUrl: input.expectedUrl,
        visible: parent.isVisible() && !parent.isMinimized(),
      })) throw new Error("WALLET_UNTRUSTED_SOURCE");
      if (value && typeof value === "object" && !Array.isArray(value) &&
          Object.keys(value).join() === "action" && (value as { action: unknown }).action === "migrate_storage") {
        if (opening || owner || input.isBusy?.(parent)) throw new Error("WALLET_BUSY");
        if (!input.host.migrateStorage) throw new Error("GENERAL_CONTROL_UNAVAILABLE");
        opening = true;
        const controller = new AbortController(); maintenanceAbort = controller;
        const cancel = () => controller.abort();
        parent.on("closed", cancel); parent.on("hide", cancel); parent.on("minimize", cancel);
        try {
          const applied = await input.host.migrateStorage(async summary => {
            const approvalEpoch = input.epoch();
            if (disposed || !input.isCurrent(parent, approvalEpoch) || !parent.isVisible() || parent.isMinimized()) return false;
            const text = await readWalletMessages(input.host.resourceDirectory, input.host.locale());
            if (disposed || !input.isCurrent(parent, approvalEpoch)) return false;
            const answer = await dialog.showMessageBox(parent, { type: "warning",
              title: text.storageMigrationTitle!, message: text.storageMigrationMessage!,
              detail: text.storageMigrationDetail!.replace("{records}", String(summary.records)).replace("{domains}", String(summary.domains)),
              buttons: [text.cancel!, text.storageMigrationConfirm!], defaultId: 0, cancelId: 0,
            });
            return answer.response === 1 && !disposed && input.isCurrent(parent, approvalEpoch) && parent.isVisible() && !parent.isMinimized();
          }, controller.signal);
          return applied ? { ok: true, value: null } : { ok: false, error: "WALLET_INTERACTION_CANCELED" };
        } finally {
          parent.off("closed", cancel); parent.off("hide", cancel); parent.off("minimize", cancel);
          maintenanceAbort = undefined; opening = false;
        }
      }
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== "action,view" ||
          (value as { action?: unknown }).action !== "open_manager" || !["create", "import", "export"].includes((value as { view: string }).view))
        throw new Error("WALLET_INVALID_REQUEST");
      if (owner?.manager.isClosing()) retire(owner);
      if (opening || input.isBusy?.(parent) || owner?.closing || owner && owner.parent !== parent) throw new Error("WALLET_BUSY");
      if (owner) { owner.manager.window.show(); owner.manager.window.focus(); return { ok: true, value: null }; }
      if (!input.host.openGeneralManagement) throw new Error("GENERAL_CONTROL_UNAVAILABLE");
      opening = true;
      let unsubscribe = () => {};
      try {
        // The still-visible parent owns the existing sensitive UI lease.
        // A nested enter would reject every management window as already busy.
        if (disposed || !input.isCurrent(parent, generation)) throw new Error("WALLET_INTERACTION_CANCELED");
        const manager = await createGeneralSetupWindow({
          resourceDirectory: join(dirname(input.host.resourceDirectory), "general-wallet-setup"),
          locale: input.host.locale, initialView: (value as { view: "create" | "import" | "export" }).view,
          localLifetime: {
            assertCurrent() { if (disposed || !input.isCurrent(parent, generation)) throw new Error("GENERAL_OPERATION_CANCELED"); },
            onInvalidated(callback) {
              const closed = () => callback(); parent.once("closed", closed);
              unsubscribe = input.host.wallet.onStateInvalidated((reason) => { if (reason === "lock_requested" || reason === "exited") callback(); });
              return () => { parent.off("closed", closed); unsubscribe(); };
            },
          },
          createSession: async (isCurrent, _restore, authenticationPhase, invalidate) => createLocalManagementSession(await input.host.openGeneralManagement!((value as { view: string }).view === "import"), {
            isCurrent, authenticationPhase, invalidate, authenticate: input.host.authenticate, cancelAuthentication: input.host.cancelAuthentication,
          }),
        });
        const item = { parent, manager }; owner = item;
        manager.window.once("closed", () => {
          retire(item); if (!parent.isDestroyed()) parent.webContents.send("koincode:trusted-wallet-ready");
        });
        manager.window.focus();
        return { ok: true, value: null };
      } finally { opening = false; }
    } catch (error) {
      const code = walletWindowError(error);
      return { ok: false, error: ["WALLET_BUSY", "WALLET_UNTRUSTED_SOURCE", "WALLET_INVALID_REQUEST", "WALLET_INTERACTION_CANCELED", "WALLET_WRITER_BUSY", "WALLET_STORAGE_MIGRATION_CONFLICT", "WALLET_LEGACY_READER_UNAVAILABLE", "PROTECTED_STORAGE_AUTH_REQUIRED", "PROTECTED_STORAGE_POLICY_INVALID", "PROTECTED_STORAGE_TIMEOUT", "WALLET_STORAGE_MIGRATION_PENDING"].includes(code)
        ? code : "GENERAL_CONTROL_UNAVAILABLE" };
    }
  });
  return () => { disposed = true; maintenanceAbort?.abort(); ipcMain.removeHandler(CHANNEL); if (owner) retire(owner); };
}
