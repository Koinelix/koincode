import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { generalSourceCommitment, type GeneralKeySource } from "../app/generalState.js";
import type { ProtectedStore } from "../app/ports.js";
import { transitionGeneralSetup, type GeneralSetupMode, type SecretAdmission } from "../domain/generalSetup.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { generalDerivationPath } from "../domain/generalDerivation.js";
import { GeneralMnemonicImport } from "./generalMnemonicImport.js";
import { runGeneralCryptoTask } from "./generalCryptoTask.js";
import type { GeneralSecretJob, GeneralStagedSource } from "./generalSecretCrypto.js";
import { GeneralGuardedState } from "./generalGuardedState.js";
import { assertGeneralMnemonicReveal } from "./generalReadyMnemonicReveal.js";
import { generalSourceInputDigest as inputDigest } from "./generalSourceInputDigest.js";
import { exportGeneralReadySecret, type GeneralExportBinding, type GeneralExportFormat, type GeneralSecretExport } from "./generalReadySecretExport.js";
import { requestGeneralSetupAuthentication, type GeneralSetupAuthorization } from "./generalManagementAuthBindings.js";
import { confirmGeneralSetupBackup, createGeneralBackupChallenge } from "./generalSetupBackupConfirmation.js";
export type { GeneralSetupAuthorization } from "./generalManagementAuthBindings.js";
type Crypto = (job: GeneralSecretJob, signal?: AbortSignal) => Promise<unknown>;
type Input = { mode: "create" } | { mode: "import_mnemonic"; phrase: string; confirmedAddress: string; accountIndex?: number }
  | { mode: "import_private_key"; privateKey: string; confirmedAddress: string };
type Authority = {
  admission(): SecretAdmission;
  authorizeSetup?(binding: GeneralSetupAuthorization, signal: AbortSignal): Promise<boolean>;
  /** Trusted host callback, never a renderer-supplied boolean. */
  authorizeReveal(setupId: string, secret?: { binding: GeneralExportBinding; address: string }): Promise<boolean>;
  authorizeExport?(binding: GeneralExportBinding, signal: AbortSignal): Promise<boolean>;
  lookupLegacyAddress(address: string): Promise<"match" | "none" | "unavailable">;
};
/** Owns only new setup state and its separately protected keys; never changes legacy subjects or grants. */
export class GeneralSetupCoordinator {
  private active?: { setupId: string; controller: AbortController; done: Promise<void>; finish: () => void };
  private preview?: { setupId: string; mode: "import_mnemonic" | "import_private_key"; address: string; key: Uint8Array; fingerprint: string };
  private readonly mnemonicImport = new GeneralMnemonicImport({
    current: () => { this.admission(); },
    preview: (id, phrase, accountIndex) => this.previewImport(id, { mode: "import_mnemonic", phrase, accountIndex }),
    exists: async address => this.state.snapshot().sources.some(item => item.address === address) || await this.authority.lookupLegacyAddress(address) === "match",
    begin: () => this.begin("import_mnemonic"),
    stage: (id, phrase, accountIndex, confirmedAddress) => this.stage(id, { mode: "import_mnemonic", phrase, accountIndex, confirmedAddress }),
    confirm: id => this.confirmImport(id),
  });
  previewAccounts(setupId: string, phrase: string, offset: number, previewId?: string) { return this.mnemonicImport.preview(setupId, phrase, offset, previewId); }
  importAccounts(setupId: string, phrase: string, previewId: string, accounts: Array<{ accountIndex: number; address: string }>) {
    return this.mnemonicImport.import(setupId, phrase, previewId, accounts);
  }
  private closed = false;
  private backupPaused = false;
  private exporting?: AbortController;
  constructor(private readonly state: GeneralGuardedState, private readonly protection: ProtectedStore,
    private readonly authority: Authority, private readonly crypto: Crypto = runGeneralCryptoTask) {}
  private admission(): SecretAdmission {
    requireWallet(!this.closed, "GENERAL_OPERATION_CANCELED", "The general wallet owner is closed.");
    requireWallet(!this.backupPaused, "GENERAL_OPERATION_BUSY", "A general wallet backup snapshot is active.");
    let status: SecretAdmission;
    try { status = this.authority.admission(); }
    catch {
      this.clearPreview(); this.mnemonicImport.clear();
      throw new WalletError("SECRET_ADMISSION_UNAVAILABLE", "Secret admission is unavailable.");
    }
    if (status !== "verified" && status !== "local_system") { this.clearPreview(); this.mnemonicImport.clear(); }
    requireWallet(status === "verified" || status === "local_system", "SECRET_ADMISSION_UNAVAILABLE", "Secret admission is unavailable.");
    return status;
  }
  private startOperation(setupId: string, controller: AbortController): void {
    let finish!: () => void; const done = new Promise<void>((resolve) => { finish = resolve; });
    this.active = { setupId, controller, done, finish };
  }
  private finishOperation(controller: AbortController): void {
    if (this.active?.controller !== controller) return;
    const operation = this.active; this.active = undefined; operation.finish();
  }
  private clearPreview(): void { this.preview?.key.fill(0); this.preview = undefined; }
  pauseForBackup(): () => void {
    requireWallet(!this.closed && !this.active && !this.backupPaused, "GENERAL_OPERATION_BUSY", "General wallet setup is busy.");
    this.backupPaused = true;
    let released = false;
    return () => { if (!released) { released = true; this.backupPaused = false; } };
  }
  async begin(mode: GeneralSetupMode): Promise<{ setupId: string }> {
    this.admission();
    requireWallet(["create", "import_mnemonic", "import_private_key"].includes(mode), "INVALID_REQUEST", "The setup mode is invalid.");
    requireWallet(!this.active, "GENERAL_OPERATION_BUSY", "A general wallet operation is already running.");
    const setupId = randomUUID(), binding = randomBytes(32).toString("hex");
    const controller = new AbortController(); this.startOperation(setupId, controller);
    try {
      requireWallet(await requestGeneralSetupAuthentication(this.authority, this.state.snapshot(), { setupId, mode, inputBinding: binding },
        controller.signal) === true, "GENERAL_AUTH_REQUIRED", "System authentication is required.");
      this.admission(); requireWallet(!controller.signal.aborted, "GENERAL_OPERATION_CANCELED", "The setup was canceled.");
      await this.state.mutate((state) => {
        this.admission(); requireWallet(!controller.signal.aborted, "GENERAL_OPERATION_CANCELED", "The setup was canceled.");
        state.setups = [...transitionGeneralSetup(state.setups, { type: "begin", id: setupId, mode, createdAt: Date.now(), inputBinding: binding }, this.admission())];
      });
      this.admission(); return { setupId };
    } finally { this.finishOperation(controller); }
  }
  /** Returns an address only; the protected result and temporary key are discarded until confirmation. */
  async previewImport(setupId: string, input: { mode: "import_mnemonic"; phrase: string; accountIndex?: number } |
    { mode: "import_private_key"; privateKey: string }): Promise<{ address: string; sourceType: "mnemonic" | "private_key"; derivationPath?: string }> {
    this.admission();
    requireWallet(!this.active, "GENERAL_OPERATION_BUSY", "A general wallet operation is already running.");
    this.clearPreview();
    const controller = new AbortController(), key = randomBytes(32), previewKey = randomBytes(32);
    let retained = false;
    this.startOperation(setupId, controller);
    try {
      const snapshot = this.state.snapshot(), setup = snapshot.setups.find((item) => item.id === setupId);
      requireWallet(setup?.phase === "started" && setup.mode === input.mode, "SETUP_CONFLICT", "The import setup is unavailable.");
      const base = { ownerId: snapshot.ownerId, keySourceId: randomUUID(), key };
      const job: GeneralSecretJob = input.mode === "import_mnemonic"
        ? { ...base, operation: "import_mnemonic", phrase: input.phrase, accountIndex: input.accountIndex ?? 0 }
        : { ...base, operation: "import_private_key", privateKey: input.privateKey };
      const value = await this.crypto(job, controller.signal) as GeneralStagedSource;
      this.admission();
      const latest = this.state.snapshot().setups.find((item) => item.id === setupId);
      requireWallet(!controller.signal.aborted && latest?.phase === "started" && value &&
        /^0x[0-9a-fA-F]{40}$/.test(value.address) &&
        value.sourceType === (input.mode === "import_mnemonic" ? "mnemonic" : "private_key") &&
        (value.sourceType !== "mnemonic" || value.derivationPath === generalDerivationPath(input.mode === "import_mnemonic" ? input.accountIndex ?? 0 : 0)),
      "SETUP_CONFLICT", "The import preview is unavailable.");
      this.preview = { setupId, mode: input.mode, address: value.address.toLowerCase(), key: previewKey,
        fingerprint: inputDigest({ ...input, confirmedAddress: value.address }, previewKey) };
      retained = true;
      return { address: value.address.toLowerCase(), sourceType: value.sourceType,
        ...(value.sourceType === "mnemonic" ? { derivationPath: value.derivationPath } : {}) };
    } finally {
      key.fill(0);
      if (!retained) previewKey.fill(0);
      this.finishOperation(controller);
    }
  }
  async stage(setupId: string, input: Input): Promise<{ status: "staged" | "already_exists" | "recovery_required" | "legacy_account"; address: string }> {
    this.admission();
    requireWallet(!this.active, "GENERAL_OPERATION_BUSY", "A general wallet operation is already running.");
    const controller = new AbortController();
    this.startOperation(setupId, controller);
    let key: Uint8Array | undefined;
    try {
      let snapshot = this.state.snapshot();
      let setup = snapshot.setups.find((item) => item.id === setupId);
      requireWallet(setup && setup.mode === input.mode && ["started", "secret_staged", "backup_pending", "ready"].includes(setup.phase),
        "SETUP_CONFLICT", "The setup is not available for this input.");
      const committed = snapshot.sources.find((source) => source.setupId === setupId);
      if (input.mode !== "create" && !committed) {
        const preview = this.preview;
        requireWallet(preview && preview.setupId === setupId && preview.mode === input.mode &&
          typeof input.confirmedAddress === "string" && input.confirmedAddress.toLowerCase() === preview.address &&
          inputDigest(input, preview.key) === preview.fingerprint,
        "SETUP_CONFLICT", "The import does not match a current address preview.");
      }
      if (!setup.pendingKeyRef) {
        const reference = `source-key:${randomUUID()}`;
        await this.state.mutate((state) => {
          this.admission();
          const item = state.setups.find((entry) => entry.id === setupId);
          requireWallet(item && item.phase === "started" && !item.pendingKeyRef, "SETUP_CONFLICT", "The setup cannot reserve another key.");
          item.pendingKeyRef = reference;
        });
        snapshot = this.state.snapshot();
        setup = snapshot.setups.find((item) => item.id === setupId)!;
      }
      const keyRef = setup.pendingKeyRef!;
      const sourceId = keyRef.slice("source-key:".length);
      const stored = await this.protection.get(keyRef);
      if (stored) {
        key = stored;
        requireWallet(stored.byteLength === 32, "GENERAL_STORE_UNAVAILABLE", "The protected source key is invalid.");
      } else key = randomBytes(32);
      this.admission();
      requireWallet(!controller.signal.aborted, "GENERAL_OPERATION_CANCELED", "The setup was canceled.");
      const fingerprint = inputDigest(input, key);
      const existing = snapshot.sources.find((source) => source.setupId === setupId);
      if (existing) {
        requireWallet(stored && existing.inputDigest === fingerprint && (input.mode === "create" ||
          typeof input.confirmedAddress === "string" && input.confirmedAddress.toLowerCase() === existing.address),
        "SETUP_CONFLICT", "The setup input has changed.");
        this.clearPreview();
        return { status: "staged", address: existing.address };
      }
      requireWallet(setup.phase === "started", "SETUP_CONFLICT", "The setup is not ready for material.");
      const base = { ownerId: snapshot.ownerId, keySourceId: sourceId, key };
      const job: GeneralSecretJob = input.mode === "create" ? { ...base, operation: "create" }
        : input.mode === "import_mnemonic" ? { ...base, operation: "import_mnemonic", phrase: input.phrase, accountIndex: input.accountIndex ?? 0 }
        : { ...base, operation: "import_private_key", privateKey: input.privateKey };
      this.admission();
      requireWallet(!controller.signal.aborted, "GENERAL_OPERATION_CANCELED", "The setup was canceled.");
      const value = await this.crypto(job, controller.signal);
      this.admission();
      requireWallet(!controller.signal.aborted, "GENERAL_OPERATION_CANCELED", "The setup was canceled.");
      const result = value as GeneralStagedSource;
      requireWallet(result && /^0x[0-9a-fA-F]{40}$/.test(result.address) && typeof result.protectedMaterial === "string" &&
        result.sourceType === (input.mode === "import_private_key" ? "private_key" : "mnemonic") &&
        (result.sourceType !== "mnemonic" || result.derivationPath === generalDerivationPath(input.mode === "import_mnemonic" ? input.accountIndex ?? 0 : 0)),
      "GENERAL_SECRET_INVALID", "The protected wallet material is invalid.");
      const address = result.address.toLowerCase();
      if (input.mode !== "create") requireWallet(typeof input.confirmedAddress === "string" &&
        input.confirmedAddress.toLowerCase() === address, "SETUP_CONFLICT", "The confirmed address does not match the import.");
      const duplicate = this.state.snapshot().sources.find((source) => source.address === address);
      const legacy = duplicate ? "none" : await this.authority.lookupLegacyAddress(address);
      this.admission();
      requireWallet(!controller.signal.aborted && (legacy === "none" || legacy === "match"),
        "GENERAL_STORE_UNAVAILABLE", "The account identity cannot be checked.");
      if (duplicate || legacy === "match") {
        await this.state.mutate((state) => { state.setups = [...transitionGeneralSetup(state.setups, { type: "cancel", id: setupId }, this.admission())]; });
        this.admission();
        requireWallet(!controller.signal.aborted, "GENERAL_OPERATION_CANCELED", "The setup was canceled.");
        this.clearPreview();
        return { status: duplicate ? duplicate.status === "ready" ? "already_exists" : "recovery_required" : "legacy_account", address };
      }
      if (!stored) {
        await this.protection.put(keyRef, key);
        const checked = await this.protection.get(keyRef);
        try { requireWallet(checked && checked.byteLength === 32 && timingSafeEqual(checked, key),
          "GENERAL_STORE_UNAVAILABLE", "The protected source key could not be verified."); }
        finally { checked?.fill(0); }
      }
      this.admission();
      requireWallet(!controller.signal.aborted, "GENERAL_OPERATION_CANCELED", "The setup was canceled.");
      const source: GeneralKeySource = { id: sourceId, setupId, address, sourceType: result.sourceType,
        protectedMaterial: result.protectedMaterial, keyRef, inputDigest: fingerprint,
        ...(result.sourceType === "mnemonic" ? { derivationPath: result.derivationPath } : {}),
        backupVerified: false, status: "staged", createdAt: Date.now() };
      await this.state.mutate((state) => {
        this.admission();
        requireWallet(!controller.signal.aborted && !state.sources.some((item) => item.address === address),
          "SETUP_CONFLICT", "The account is no longer available for this setup.");
        state.setups = [...transitionGeneralSetup(state.setups, { type: "stageCommitted", id: setupId,
          stagedCommitment: generalSourceCommitment(source) }, this.admission())];
        state.sources.push(source);
      });
      this.admission();
      requireWallet(!controller.signal.aborted, "GENERAL_OPERATION_CANCELED", "The setup was canceled.");
      this.clearPreview();
      return { status: "staged", address };
    } finally {
      key?.fill(0);
      this.finishOperation(controller);
    }
  }
  async confirmImport(setupId: string): Promise<void> {
    this.admission();
    requireWallet(!this.active, "GENERAL_OPERATION_BUSY", "A general wallet operation is already running.");
    const controller = new AbortController();
    this.startOperation(setupId, controller);
    try {
      await this.state.mutate((state) => {
        this.admission();
        requireWallet(!controller.signal.aborted, "GENERAL_OPERATION_CANCELED", "The setup was canceled.");
        const setup = state.setups.find((item) => item.id === setupId);
        if (setup?.phase === "ready" && setup.mode !== "create") return;
        state.setups = [...transitionGeneralSetup(state.setups, { type: "confirmImported", id: setupId }, this.admission())];
        const source = state.sources.find((item) => item.setupId === setupId);
        requireWallet(source, "GENERAL_STORE_UNAVAILABLE", "The protected source is unavailable.");
        source.status = "ready";
      });
      this.admission();
      // Once the protected state write began, cancellation cannot undo an already committed account.
    } finally { this.finishOperation(controller); }
  }

  async revealCreated(setupId: string): Promise<{ phrase: string; positions: number[] }> {
    this.admission();
    requireWallet(!this.active, "GENERAL_OPERATION_BUSY", "A general wallet operation is already running.");
    const controller = new AbortController();
    this.startOperation(setupId, controller);
    try {
      const original = this.state.snapshot(), staged = original.sources.find((source) => source.setupId === setupId);
      requireWallet(staged && staged.sourceType === "mnemonic" && original.setups.some((setup) => setup.id === setupId && setup.mode === "create" &&
        ["secret_staged", "backup_pending"].includes(setup.phase)), "SETUP_NOT_STAGED", "Durably staged material is required before display.");
      requireWallet(await this.authority.authorizeReveal(setupId, { binding: Object.freeze({ sourceId: staged.id, setupId,
        sourceCommitment: generalSourceCommitment(staged), format: "mnemonic" }), address: staged.address }) === true,
      "GENERAL_AUTH_REQUIRED", "System authentication is required.");
      this.admission();
      requireWallet(!controller.signal.aborted, "GENERAL_OPERATION_CANCELED", "The setup was canceled.");
      const snapshot = this.state.snapshot();
      const operation = snapshot.setups.find((item) => item.id === setupId);
      requireWallet(operation && operation.mode === "create" && ["secret_staged", "backup_pending"].includes(operation.phase),
        "SETUP_NOT_STAGED", "Durably staged material is required before display.");
      if (operation.phase === "secret_staged") {
        const positions = createGeneralBackupChallenge();
        await this.state.mutate((state) => {
          this.admission();
          requireWallet(!controller.signal.aborted, "GENERAL_OPERATION_CANCELED", "The setup was canceled.");
          state.setups = [...transitionGeneralSetup(state.setups, { type: "reveal", id: setupId }, this.admission())];
          state.setups.find((item) => item.id === setupId)!.backupPositions = positions;
        });
      }
      this.admission();
      requireWallet(!controller.signal.aborted, "GENERAL_OPERATION_CANCELED", "The setup was canceled.");
      const current = this.state.snapshot();
      const source = current.sources.find((item) => item.setupId === setupId);
      const setup = current.setups.find((item) => item.id === setupId);
      requireWallet(source && setup?.phase === "backup_pending" && setup.backupPositions,
        "GENERAL_STORE_UNAVAILABLE", "The protected setup is unavailable.");
      const key = await this.protection.get(source.keyRef);
      if (!key || key.byteLength !== 32) { key?.fill(0); throw new WalletError("GENERAL_STORE_UNAVAILABLE", "The protected source key is unavailable."); }
      try {
        this.admission();
        requireWallet(!controller.signal.aborted, "GENERAL_OPERATION_CANCELED", "The setup was canceled.");
        const result = await this.crypto({ operation: "reveal", ownerId: current.ownerId, keySourceId: source.id,
          key, address: source.address, derivationPath: source.derivationPath, envelope: source.protectedMaterial }, controller.signal);
        this.admission();
        requireWallet(!controller.signal.aborted, "GENERAL_OPERATION_CANCELED", "The setup was canceled.");
        const latest = this.state.snapshot().setups.find((item) => item.id === setupId);
        requireWallet(latest?.phase === "backup_pending", "SETUP_CONFLICT", "The setup is no longer available.");
        const phrase = assertGeneralMnemonicReveal(result, source.address, source.derivationPath);
        this.admission();
        requireWallet(!controller.signal.aborted, "GENERAL_OPERATION_CANCELED", "The setup was canceled.");
        return { phrase, positions: [...setup.backupPositions] };
      } finally { key.fill(0); }
    } finally { this.finishOperation(controller); }
  }

  async revealReadyMnemonic(sourceId: string): Promise<{ phrase: string }> {
    const result = await this.readySecret(sourceId, "mnemonic", (binding) => {
      const source = this.state.snapshot().sources.find((item) => item.id === binding.sourceId);
      requireWallet(source && generalSourceCommitment(source) === binding.sourceCommitment, "GENERAL_ACCOUNT_UNAVAILABLE", "The wallet source is unavailable.");
      return this.authority.authorizeReveal(binding.setupId, { binding, address: source.address });
    });
    return { phrase: (result as { phrase: string }).phrase };
  }
  exportSecret(sourceId: string, format: GeneralExportFormat): Promise<GeneralSecretExport> {
    return this.readySecret(sourceId, format, async (binding, signal) =>
      this.authority.authorizeExport ? this.authority.authorizeExport(binding, signal) : false);
  }
  private async readySecret(sourceId: string, format: GeneralExportFormat,
    authorize: (binding: GeneralExportBinding, signal: AbortSignal) => Promise<boolean>): Promise<GeneralSecretExport> {
    this.admission();
    requireWallet(!this.active, "GENERAL_OPERATION_BUSY", "A general wallet operation is already running.");
    const state = this.state.snapshot(), source = state.sources.find((item) => item.id === sourceId);
    requireWallet(source?.status === "ready" && (format !== "mnemonic" || source.sourceType === "mnemonic") &&
      state.setups.some((setup) => setup.id === source.setupId && setup.phase === "ready"),
    format === "mnemonic" ? "GENERAL_MNEMONIC_UNAVAILABLE" : "GENERAL_ACCOUNT_UNAVAILABLE", "The wallet source is unavailable.");
    const controller = new AbortController();
    this.startOperation(source.setupId, controller); this.exporting = controller;
    try {
      return await exportGeneralReadySecret({ state: this.state, protection: this.protection, source, format, signal: controller.signal,
        admission: () => this.admission(), authorize, crypto: this.crypto });
    } finally { this.exporting = undefined; this.finishOperation(controller); }
  }
  cancelSecretExport(): void { this.exporting?.abort(); }
  async confirmBackup(setupId: string, words: string[]): Promise<boolean> {
    this.admission();
    requireWallet(!this.active, "GENERAL_OPERATION_BUSY", "A general wallet operation is already running.");
    const controller = new AbortController();
    this.startOperation(setupId, controller);
    try {
      return await confirmGeneralSetupBackup({ state: this.state, protection: this.protection, setupId, words, signal: controller.signal,
        admission: () => this.admission(), secretAdmission: () => this.admission(), crypto: this.crypto });
    } finally { this.finishOperation(controller); }
  }

  async cancel(setupId: string): Promise<void> {
    requireWallet(!this.closed, "GENERAL_OPERATION_CANCELED", "The general wallet owner is closed.");
    if (this.mnemonicImport.clear(setupId)) this.active?.controller.abort();
    if (this.active?.setupId === setupId) this.active.controller.abort();
    if (this.preview?.setupId === setupId) this.clearPreview();
    await this.state.mutate((state) => {
      // Cancellation never grants access to secrets and must not depend on admission lookup.
      state.setups = [...transitionGeneralSetup(state.setups, { type: "cancel", id: setupId }, "unavailable")];
    });
  }

  async resume(setupId: string): Promise<void> {
    this.admission();
    requireWallet(!this.active, "GENERAL_OPERATION_BUSY", "A general wallet operation is already running.");
    const controller = new AbortController();
    this.startOperation(setupId, controller);
    try {
      const snapshot = this.state.snapshot(), setup = snapshot.setups.find((item) => item.id === setupId);
      requireWallet(setup, "SETUP_CONFLICT", "The original setup is unavailable.");
      const authorized = await requestGeneralSetupAuthentication(this.authority, snapshot, { setupId, mode: setup.mode, inputBinding: setup.inputBinding }, controller.signal, true);
      this.admission();
      requireWallet(!controller.signal.aborted, "GENERAL_OPERATION_CANCELED", "The setup was canceled.");
      requireWallet(authorized === true, "GENERAL_AUTH_REQUIRED", "System authentication is required.");
      await this.state.mutate((state) => {
        this.admission();
        requireWallet(!controller.signal.aborted, "GENERAL_OPERATION_CANCELED", "The setup was canceled.");
        state.setups = [...transitionGeneralSetup(state.setups, { type: "resume", id: setupId }, this.admission())];
      });
      this.admission();
      requireWallet(!controller.signal.aborted, "GENERAL_OPERATION_CANCELED", "The setup was canceled.");
    } finally { this.finishOperation(controller); }
  }

  listSetups(): Array<{ setupId: string; mode: GeneralSetupMode; phase: string; createdAt: number }> {
    return this.state.snapshot().setups.filter((item) => item.phase !== "ready").map((item) => ({
      setupId: item.id, mode: item.mode, phase: item.phase, createdAt: item.createdAt,
    }));
  }

  listAccounts(): Array<{ sourceId: string; address: string; sourceType: "mnemonic" | "private_key"; backupVerified: boolean }> {
    return this.state.snapshot().sources.filter((source) => source.status === "ready").map((source) => ({ sourceId: source.id, address: source.address, sourceType: source.sourceType, backupVerified: source.backupVerified }));
  }

  /** The owning utility calls this on shutdown or sensitive-window invalidation. */
  close(): Promise<void> {
    this.closed = true; const operation = this.active;
    operation?.controller.abort(); this.clearPreview(); this.mnemonicImport.clear();
    return operation?.done ?? Promise.resolve();
  }
}
