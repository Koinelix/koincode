import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { validateGeneralState } from "../app/generalState.js";
import type { ProtectedStore } from "../app/ports.js";
import { GENERAL_SIGNING_POLICY_DIGEST, GENERAL_SIGNING_POLICY_VERSION } from "../domain/generalSigningPolicy.js";
import { requireWallet } from "../domain/errors.js";
import { digest } from "./canonical.js";
import { createLocalGeneralProtection } from "./generalKeychain.js";
import { generalExportAuthenticationScope, generalSetupAuthenticationScope } from "./generalManagementAuthBindings.js";
import { GeneralWalletRuntime } from "./generalWalletRuntime.js";
import { SqliteGeneralStateRepository } from "./generalStateRepository.js";
import { SqliteGeneralSigningJournalRepository } from "./generalSigningJournalRepository.js";

export type LocalManagementAuthentication = { action: string; operationDigest: string; accountAddress: string | null };
const actions = new Set(["status", "begin", "stage_create", "preview_mnemonic", "preview_accounts", "import_accounts", "preview_private_key", "stage_mnemonic",
  "stage_private_key", "reveal_created", "confirm_backup", "confirm_import", "cancel", "resume", "reveal_ready_mnemonic",
  "export_secret", "cancel_secret_export", "connect_payment", "upgrade_payments"]);

/** Private existing-utility owner. Local Keychain protection is explicitly not H1 native admission. */
export class LocalGeneralManagement {
  private runtime?: GeneralWalletRuntime;
  private session?: ReturnType<GeneralWalletRuntime["openProtectedSession"]>;
  private active?: Promise<unknown>;
  private closing?: Promise<void>;
  private stopped = false;
  private readonly lifetime = new AbortController();
  private readonly protection: ProtectedStore;
  constructor(private readonly input: {
    directory: string; keychainHelper: string; isCurrent(): boolean;
    paymentNetwork?: import("../domain/model.js").Network;
    protection?: ProtectedStore;
    legacyAccounts?(): Array<{ sourceId: string; address: string; sourceType: "private_key"; backupVerified: boolean }>;
    registerPaymentSource?(key: import("../app/ports.js").GeneralManagedKey, signal: AbortSignal): Promise<unknown>;
    upgradePayments?(authenticate: (scope: LocalManagementAuthentication, signal: AbortSignal) => Promise<boolean>, signal: AbortSignal): Promise<unknown>;
    exportLegacyKey?(id: string, authenticate: (scope: LocalManagementAuthentication, signal: AbortSignal) => Promise<boolean>, signal: AbortSignal): Promise<unknown>;
    authenticate(scope: LocalManagementAuthentication, signal: AbortSignal): Promise<boolean>;
    lookupLegacyAddress(address: string): Promise<"match" | "none" | "unavailable">;
  }) {
    this.protection = createLocalGeneralProtection(input.keychainHelper, input.protection);
  }
  private current(): void {
    requireWallet(!this.stopped && this.input.isCurrent(), "GENERAL_OPERATION_CANCELED", "The local management window is unavailable.");
  }
  open(): Promise<void> {
    const work = this.openExisting();
    this.active = work;
    void work.finally(() => { if (this.active === work) this.active = undefined; }).catch(() => {});
    return work;
  }
  private async openExisting(): Promise<void> {
    this.current();
    if (existsSync(this.input.directory)) await this.construct("open");
    else {
      // A surviving checkpoint is never evidence of a fresh, empty installation.
      const previous = await this.protection.get("general-state-v1");
      try { requireWallet(previous === null, "GENERAL_STORE_UNAVAILABLE", "The local wallet projection is missing."); }
      finally { previous?.fill(0); }
    }
    this.current();
  }
  private async construct(mode: "create" | "open", setupMode?: string): Promise<void> {
    this.current();
    const initial = mode === "create" ? validateGeneralState({ format: "koincode-general-wallet-state", version: 1,
      ownerId: randomUUID(), installationId: randomUUID(), revision: 0, signingPolicyVersion: GENERAL_SIGNING_POLICY_VERSION,
      signingPolicyDigest: GENERAL_SIGNING_POLICY_DIGEST, sources: [], setups: [] }) : undefined;
    if (initial && setupMode !== "import_mnemonic" && setupMode !== "import_private_key") {
      requireWallet(await this.input.authenticate({ action: "initialize_local_wallet", operationDigest: digest(initial), accountAddress: null },
        this.lifetime.signal), "GENERAL_AUTH_REQUIRED", "System authentication is required.");
      this.current();
    }
    const projection = SqliteGeneralStateRepository.open(this.input.directory, mode);
    const authority = {
      admission: () => { try { this.current(); return "local_system" as const; } catch { return "unavailable" as const; } },
      authorizeSetup: async (binding: Parameters<typeof generalSetupAuthenticationScope>[0], signal: AbortSignal) => {
        this.current();
        const scope = generalSetupAuthenticationScope(binding);
        // Local imports are admitted by the private window, without an OS authentication prompt.
        if (binding.mode === "import_mnemonic" || binding.mode === "import_private_key") return !signal.aborted;
        return this.input.authenticate(scope, signal);
      },
      authorizeReveal: async (_id: string, source?: { binding: Parameters<typeof generalExportAuthenticationScope>[0]; address: string }) => {
        this.current(); requireWallet(source, "GENERAL_ACCOUNT_UNAVAILABLE", "The source binding is missing.");
        return this.input.authenticate(generalExportAuthenticationScope(source.binding, source.address), this.lifetime.signal);
      },
      authorizeExport: (binding: Parameters<typeof generalExportAuthenticationScope>[0], signal: AbortSignal) => {
        this.current(); const address = this.runtime?.setup.listAccounts().find((source) => source.sourceId === binding.sourceId)?.address;
        requireWallet(address, "GENERAL_ACCOUNT_UNAVAILABLE", "The source is unavailable.");
        return this.input.authenticate(generalExportAuthenticationScope(binding, address), signal);
      },
      lookupLegacyAddress: this.input.lookupLegacyAddress,
    };
    try {
      const input = { projection, protection: this.protection, authority,
        journalRepository: () => SqliteGeneralSigningJournalRepository.open(join(this.input.directory, "history"), mode),
        isFreshSource: async (address: string) => await this.input.lookupLegacyAddress(address) === "none" };
      this.runtime = initial ? await GeneralWalletRuntime.create(input, initial) : await GeneralWalletRuntime.open(input);
      // Management and recovery remain available when an older signing policy is paused.
      // Payment and manual signing keep their own current-policy and journal gates.
      this.session = this.runtime.openProtectedSession(() => !this.stopped && this.input.isCurrent());
    } catch (error) { if (this.runtime) await this.runtime.close(); else projection.close(); throw error; }
  }
  async signAllowance(wallet: import("../app/ports.js").ManagedKey, tx: import("../domain/allowanceTransaction.js").AllowanceTransaction, signal: AbortSignal) {
    this.current(); requireWallet(this.runtime, "GENERAL_ACCOUNT_UNAVAILABLE", "The original source owner is unavailable.");
    return this.runtime.signAllowance(wallet, tx, AbortSignal.any([signal, this.lifetime.signal]));
  }
  async preparePayment(intent: import("./generalExactPayment.js").GeneralExactPayment, signal?: AbortSignal) {
    this.current(); requireWallet(this.runtime, "GENERAL_ACCOUNT_UNAVAILABLE", "The original source owner is unavailable.");
    return this.runtime.prepareLocalPayment(intent, signal);
  }
  dispatch(command: unknown): Promise<unknown> {
    this.current();
    requireWallet(command && typeof command === "object" && !Array.isArray(command) && actions.has((command as { action: string }).action),
      "INVALID_REQUEST", "The basic local management command is invalid.");
    const action = (command as { action: string }).action;
    if (action === "cancel" || action === "cancel_secret_export") return this.session ? this.session.dispatch(command) : Promise.resolve(null);
    requireWallet(!this.active, "GENERAL_OPERATION_BUSY", "The local management owner is busy.");
    const work = (async () => {
      const legacy = this.input.legacyAccounts?.() ?? [];
      if (action === "upgrade_payments") {
        requireWallet(Object.keys(command).join() === "action" && this.input.upgradePayments,
          "INVALID_REQUEST", "The explicit payment-source upgrade is unavailable.");
        const result = await this.input.upgradePayments(this.input.authenticate, this.lifetime.signal); this.current(); return result;
      }
      if (action === "connect_payment") {
        requireWallet(Object.keys(command).sort().join() === "action,sourceId", "INVALID_REQUEST", "The payment source selection is invalid.");
        const id = (command as { sourceId: string }).sourceId;
        if (legacy.some((source) => source.sourceId === id)) return { status: "connected", walletId: id };
        const key = this.runtime?.localPaymentSources(undefined, this.input.paymentNetwork).find((source) => source.source.sourceId === id);
        requireWallet(key && this.input.registerPaymentSource, "GENERAL_ACCOUNT_UNAVAILABLE", "The original local source is unavailable.");
        const result = await this.input.registerPaymentSource(key, this.lifetime.signal); this.current(); return result;
      }
      if (action === "export_secret" && legacy.some((source) => source.sourceId === (command as { sourceId?: unknown }).sourceId)) {
        requireWallet(Object.keys(command).sort().join() === "action,format,sourceId" &&
          (command as { format?: unknown }).format === "private_key" && this.input.exportLegacyKey,
        "GENERAL_MNEMONIC_UNAVAILABLE", "This original wallet stores only its private key.");
        const result = await this.input.exportLegacyKey((command as { sourceId: string }).sourceId,
          this.input.authenticate, this.lifetime.signal); this.current(); return result;
      }
      if (!this.runtime && action === "status") {
        requireWallet(Object.keys(command).join() === "action", "INVALID_REQUEST", "The status request is invalid.");
        return { accounts: legacy, setups: [] };
      }
      if (!this.runtime) {
        requireWallet(action === "begin" && Object.keys(command).sort().join() === "action,mode" &&
          ["create", "import_mnemonic", "import_private_key"].includes((command as { mode: string }).mode),
        "INVALID_REQUEST", "Explicit setup is required.");
        await this.construct("create", (command as { mode: string }).mode);
      }
      if (action === "begin") {
        requireWallet(Object.keys(command).sort().join() === "action,mode" &&
          ["create", "import_mnemonic", "import_private_key"].includes((command as { mode: string }).mode),
        "INVALID_REQUEST", "Explicit setup is required.");
        if ((command as { mode: string }).mode !== "create") {
          // Retain the original source and recovery phase while freeing the single active setup slot.
          for (const setup of this.runtime!.setup.listSetups()) {
            if (["started", "secret_staged", "backup_pending"].includes(setup.phase)) {
              this.current(); await this.session!.dispatch({ action: "cancel", setupId: setup.setupId });
            }
          }
        }
      }
      this.current(); const result = await this.session!.dispatch(command);
      if (this.input.registerPaymentSource && action === "import_accounts") {
        const rows = (result as { results: Array<{ address: string; status: string; paymentStatus?: "connected" | "needs_upgrade" | "unavailable" }> }).results;
        const keys = this.runtime!.localPaymentSources(undefined, this.input.paymentNetwork);
        for (const row of rows.filter(item => item.status === "imported")) {
          this.current(); row.paymentStatus = "unavailable";
          const key = keys.find(item => item.address === row.address);
          if (!key) continue;
          try {
            const registration = await this.input.registerPaymentSource(key, this.lifetime.signal) as { status?: unknown } | undefined;
            if (registration?.status === "connected" || registration?.status === "needs_upgrade") row.paymentStatus = registration.status;
          } catch { /* Durable account import remains successful when payment registration is unavailable. */ }
          this.current();
        }
      }
      if (this.input.registerPaymentSource && (action === "confirm_import" || action === "confirm_backup" && (result as { verified?: boolean }).verified === true)) {
        for (const key of this.runtime!.localPaymentSources((command as { setupId: string }).setupId, this.input.paymentNetwork))
          await this.input.registerPaymentSource(key, this.lifetime.signal);
        this.current();
      }
      if (action === "status") return { ...(result as { setups: unknown[] }), accounts: [...legacy, ...(result as { accounts: unknown[] }).accounts] };
      return result;
    })();
    this.active = work; void work.finally(() => { if (this.active === work) this.active = undefined; }).catch(() => {}); return work;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true; this.lifetime.abort();
    return this.closing = (async () => {
      // Session close cancels the original coordinator before awaiting active crypto or storage.
      if (this.session) await this.session.close();
      await this.active?.catch(() => {});
      await this.runtime?.close();
    })();
  }
}
