import type { ProtectedHostConnection } from "../protected-host.js";
import type { GeneralWalletState } from "../app/generalState.js";
import type { GeneralExportBinding } from "./generalReadySecretExport.js";
import type { GeneralSetupCommand } from "./generalSetupSession.js";
import type { GeneralInitializationRecord } from "./generalInitializationRecord.js";
import { parseGeneralInitializationRecord } from "./generalInitializationRecord.js";
import { GeneralProtectedScope } from "./generalProtectedScope.js";
import { generalProtectedInitialCandidate } from "./generalProtectedInitialization.js";
import { GeneralWalletRuntime } from "./generalWalletRuntime.js";
import { ProtectedGeneralStateRepository, ProtectedGeneralSigningJournalRepository } from "./generalProtectedRepositories.js";
import { generalExportAuthenticationScope, generalSetupAuthenticationScope } from "./generalManagementAuthBindings.js";
import { requireWallet } from "../domain/errors.js";
import { digest } from "./canonical.js";

type Legacy = { lookupAddress(address: string): Promise<"match" | "none" | "unavailable">; isFreshSource(address: string, networkId: string): Promise<boolean> };
const actions = new Set(["status", "begin", "stage_create", "preview_mnemonic", "preview_accounts", "import_accounts", "preview_private_key", "stage_mnemonic", "stage_private_key", "reveal_created",
  "confirm_backup", "confirm_import", "cancel", "resume", "reveal_ready_mnemonic", "export_secret", "cancel_secret_export"]);
/** Internal runtime factory, supplied only by the fixed independent Host. The
 * legacy reader must be its actual sealed original-ledger owner, never a Main
 * snapshot. Missing that owner fails closed at the existing setup check. */
export class GeneralProtectedManagement {
  private readonly scope: GeneralProtectedScope;
  private record?: GeneralInitializationRecord;
  private runtime?: GeneralWalletRuntime;
  private projection?: ProtectedGeneralStateRepository;
  private session?: ReturnType<GeneralWalletRuntime["openProtectedSession"]>;
  private active?: Promise<unknown>;
  private closing?: Promise<void>;
  private stopped = false;
  constructor(private readonly connection: ProtectedHostConnection, private readonly locale: "en-US" | "zh-CN",
    private readonly isCurrent: () => boolean, authenticationPhase: (pending: boolean) => void, private readonly legacy: Legacy) {
    this.scope = new GeneralProtectedScope(connection, locale, authenticationPhase);
  }
  private current(): void {
    requireWallet(!this.stopped && this.isCurrent() === true, "GENERAL_OPERATION_CANCELED", "The original management window is unavailable.");
    this.connection.assertCurrent();
  }
  private async initialization(): Promise<GeneralInitializationRecord | null> {
    const bytes = await this.scope.get("general-initialization-v1");
    if (!bytes) return null;
    try {
      const record = parseGeneralInitializationRecord(bytes);
      requireWallet(record.installationId === this.connection.identity.installationId && record.uid === this.connection.identity.uid && record.kind === "new",
        "GENERAL_INITIALIZATION_RECORD_INVALID", "The actual profile belongs to another installation.");
      return record;
    } finally { bytes.fill(0); }
  }
  private async construct(initial?: GeneralWalletState): Promise<void> {
    const record = this.record!;
    const projection = this.projection = new ProtectedGeneralStateRepository(this.connection.repository("state"));
    const journalRepository = () => new ProtectedGeneralSigningJournalRepository(this.connection.repository("signing"));
    const addressFor = (binding: GeneralExportBinding): string => {
      const address = this.runtime?.setup.listAccounts().find((source) => source.sourceId === binding.sourceId)?.address;
      requireWallet(address, "GENERAL_ACCOUNT_UNAVAILABLE", "The original source is unavailable."); return address;
    };
    const authority = {
      admission: () => { try { this.current(); return "verified" as const; } catch { return "unavailable" as const; } },
      authorizeSetup: async (binding: Parameters<typeof generalSetupAuthenticationScope>[0], signal: AbortSignal) => {
        this.current(); await this.scope.authorize(generalSetupAuthenticationScope(binding), signal); return true;
      },
      authorizeReveal: async (_setupId: string, source?: { binding: GeneralExportBinding; address: string }) => {
        this.current(); requireWallet(source, "GENERAL_ACCOUNT_UNAVAILABLE", "The original export binding is unavailable.");
        await this.scope.authorize(generalExportAuthenticationScope(source.binding, source.address)); return true;
      },
      authorizeExport: async (binding: GeneralExportBinding, signal: AbortSignal) => {
        this.current(); await this.scope.authorize(generalExportAuthenticationScope(binding, addressFor(binding)), signal); return true;
      },
      lookupLegacyAddress: (address: string) => this.legacy.lookupAddress(address),
    };
    const input = { projection, journalRepository, protection: this.scope, authority, isFreshSource: this.legacy.isFreshSource.bind(this.legacy), initialSigningDomainId: record.initialSigningDomainId };
    this.runtime = initial ? await GeneralWalletRuntime.create(input, initial) : await GeneralWalletRuntime.open(input);
    requireWallet(this.runtime.signingJournal, "SIGNING_CONTINUITY_UNKNOWN", "The actual signing history cannot be verified.");
    this.session = this.runtime.openProtectedSession(() => { try { this.current(); return true; } catch { return false; } });
  }
  /** Read-only initialization. A missing profile is displayed without creating
   * any resource or prompting for authentication. */
  async open(): Promise<void> {
    this.current(); await this.connection.ready; await this.scope.inspection();
    try {
      const record = await this.initialization(); if (!record) return;
      requireWallet(record.phase === "ready", "GENERAL_RECOVERY_REQUIRED", "The original initialization requires recovery.");
      this.record = record; await this.scope.resources(record); await this.construct();
      await this.capture();
    } finally { await this.scope.end(); }
  }
  private async create(): Promise<void> {
    this.current(); requireWallet(!this.record && !this.runtime, "GENERAL_OPERATION_BUSY", "The original profile already exists.");
    const candidate = generalProtectedInitialCandidate(this.connection.identity);
    // A second native read under the same owner precedes the only explicit
    // initialization action. Never turn a failed open into a new blank owner.
    await this.scope.inspection();
    try { requireWallet(await this.initialization() === null, "GENERAL_RECOVERY_REQUIRED", "An original initialization already exists."); }
    finally { await this.scope.end(); }
    await this.scope.initialize(candidate.record); this.record = candidate.record;
    await this.scope.resources(candidate.record); await this.construct(candidate.state);
    const ready = await this.initialization();
    requireWallet(ready?.phase === "ready" && ready.planDigest === candidate.record.planDigest,
      "GENERAL_INITIALIZATION_INCOMPLETE", "The original initialization has not completed.");
    this.record = ready; await this.scope.end();
  }
  private async capture(): Promise<void> {
    // The broker observes these same two protected reads around actual SQL and
    // original journal verification. Public metadata is derived there, not here.
    const before = await this.scope.get("general-state-v1");
    try {
      requireWallet(before && this.runtime?.signingJournal, "GENERAL_STORE_UNAVAILABLE", "The original state is unavailable.");
      const rows = this.projection?.read();
      requireWallet(rows, "GENERAL_STORE_UNAVAILABLE", "The original projection is unavailable.");
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(before)) as { digest?: unknown };
      requireWallet(parsed.digest === digest(rows), "GENERAL_STORE_UNAVAILABLE", "The original projection disagrees with its checkpoint.");
      const after = await this.scope.get("general-state-v1");
      try { requireWallet(after && Buffer.from(before).equals(after), "GENERAL_STORE_UNAVAILABLE", "The original state changed during inspection."); }
      finally { after?.fill(0); }
    } finally { before?.fill(0); }
  }
  dispatch(command: unknown): Promise<unknown> {
    this.current();
    requireWallet(command && typeof command === "object" && !Array.isArray(command) && actions.has((command as { action: string }).action),
      "INVALID_REQUEST", "The basic management command is invalid.");
    const action = (command as GeneralSetupCommand).action;
    if (action === "cancel" || action === "cancel_secret_export") return this.session ? this.session.dispatch(command) : Promise.resolve(null);
    requireWallet(!this.active, "GENERAL_OPERATION_BUSY", "The original management command is busy.");
    const work = (async () => {
      if (!this.runtime && action === "status") return { accounts: [], setups: [] };
      if (!this.runtime) { requireWallet(action === "begin", "GENERAL_NOT_INITIALIZED", "Explicit setup is required."); await this.create(); }
      const result = await this.session!.dispatch(command); this.current();
      if (["confirm_backup", "confirm_import", "export_secret", "reveal_ready_mnemonic"].includes(action)) {
        await this.scope.inspection(); try { await this.capture(); } finally { await this.scope.end(); }
      }
      return result;
    })();
    this.active = work; void work.finally(() => { if (this.active === work) this.active = undefined; }).catch(() => {}); return work;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.closing = (async () => {
      // Runtime.close revokes its original crypto/setup work and awaits actual
      // worker termination before the repositories and transport can close.
      await this.runtime?.close(); await this.active?.catch(() => {});
      await this.scope.close();
    })();
    return this.closing;
  }
}
