import { mkdirSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import type { ClockSources } from "../app/clock.js";
import { protectedJson, sameCommitment } from "../app/commitments.js";
import { validateBackupHistory } from "../app/backupHistory.js";
import { GuardedWalletState } from "../app/guardedState.js";
import type { KeyCustody, ProtectedStore, WalletChain } from "../app/ports.js";
import { WalletRuntime } from "../app/runtime.js";
import { requireWallet, WalletError } from "../domain/errors.js";
import { WalletDatabase } from "./database.js";
import { SqliteWalletRepository } from "./repository.js";
import { acquireProfileLease } from "./profileLease.js";
import type { ProfileBinding, ProtectedProfile } from "./profileRecords.js";
import { stateCommitment } from "./stateCommitment.js";
import { digest } from "./canonical.js";
import { assertNoPendingRelocation } from "./relocationJournal.js";
export async function recoverWalletProfile(input: {
  mode: "recover" | "resume_recovery";
  paymentNetwork?: import("../domain/model.js").Network;
  directory: string;
  installationId?: string;
  leaseDirectory: string;
  backup: string;
  password: string;
  acceptVerifiedGrossOutflow: boolean;
  protection: ProtectedStore;
  custody: KeyCustody;
  chain: WalletChain;
  sources: ClockSources;
  signal?: AbortSignal;
}): Promise<WalletRuntime> {
  const {
    mode,
    directory: requested,
    leaseDirectory,
    backup,
    password,
    acceptVerifiedGrossOutflow,
    protection,
    custody,
    chain,
    sources,
  } = input;
  requireWallet(
    isAbsolute(requested) &&
      isAbsolute(leaseDirectory) &&
      Buffer.byteLength(backup) <= 16 * 1024 * 1024,
    "BACKUP_INVALID",
    "Bounded encrypted backup and absolute recovery directories are required.",
  );
  const cancel = AbortSignal.any([
    AbortSignal.timeout(120000),
    ...(input.signal ? [input.signal] : []),
  ]);
  const lease = acquireProfileLease(leaseDirectory);
  let database: WalletDatabase | undefined,
    owner: GuardedWalletState | undefined,
    runtime: WalletRuntime | undefined;
  try {
    await assertNoPendingRelocation(protection);
    let previous: ProtectedProfile | null;
    try {
      previous = await protectedJson<ProtectedProfile>(protection, "wallet-profile");
    } catch (error) {
      requireWallet(
        mode === "recover" &&
          error instanceof WalletError &&
          error.code === "WALLET_RECOVERY_REQUIRED",
        "WALLET_RECOVERY_REQUIRED",
        "The protected profile must be repaired through explicit recovery.",
      );
      previous = null;
    }
    const backupDigest = digest(backup);
    if (mode === "resume_recovery")
      requireWallet(
        previous?.version === 1 &&
          previous.recovery &&
          /^[0-9a-f-]{36}$/.test(previous.recovery.recoveryId) &&
          previous.recovery.backupDigest === backupDigest &&
          ["RECOVERING", "READY"].includes(previous.phase),
        "WALLET_RECOVERY_REQUIRED",
        "The supplied backup does not match the pending installation recovery.",
      );
    // Reject bad passwords, invalid keys, baselines and history before replacing any profile.
    const preflight = await custody.restoreBackup(backup, password, cancel);
    requireWallet(preflight.key.network === (input.paymentNetwork ?? "eip155:84532"),
      "PAYMENT_NETWORK_MISMATCH", "The backup belongs to a different fixed payment network.");
    const history = validateBackupHistory(preflight.metadata, (state, commitment) => {
      requireWallet(
        typeof commitment.storageBinding === "string" &&
          /^[0-9a-f]{64}$/.test(commitment.storageBinding) &&
          sameCommitment(stateCommitment(state, commitment.storageBinding), commitment),
        "BACKUP_INVALID",
        "Backup history does not match its authenticated commitment.",
      );
    });
    requireWallet(
      !cancel.aborted,
      "WALLET_OPERATION_ABORTED",
      "Installation recovery was canceled during preflight.",
    );
    if (mode === "recover") mkdirSync(requested, { recursive: true, mode: 0o700 });
    const directory = realpathSync(requested);
    if (mode === "resume_recovery")
      requireWallet(
        previous!.directory === directory,
        "WALLET_RECOVERY_REQUIRED",
        "Only the original pending recovery directory can resume.",
      );
    const recoveredOwnerId =
      previous && /^[0-9a-f-]{36}$/.test(previous.ownerId)
        ? previous.ownerId
        : history.state.ownerId;
    database =
      mode === "recover"
        ? WalletDatabase.createForRecovery(directory, recoveredOwnerId, input.installationId)
        : WalletDatabase.openExisting(directory);
    const repository = new SqliteWalletRepository(database),
      state = repository.read();
    const previousBinding: ProfileBinding | null =
      previous &&
      typeof previous.directory === "string" &&
      typeof previous.installationId === "string" &&
      typeof previous.ownerId === "string"
        ? {
            directory: previous.directory,
            installationId: previous.installationId,
            ownerId: previous.ownerId,
            ...(previous.recovery ? { recoveryId: previous.recovery.recoveryId } : {}),
          }
        : null;
    const profile: ProtectedProfile =
      mode === "recover"
        ? {
            version: 1,
            directory,
            installationId: state.installationId,
            ownerId: state.ownerId,
            phase: "RECOVERING",
            recovery: { recoveryId: randomUUID(), backupDigest, previous: previousBinding },
          }
        : previous!;
    requireWallet(
      profile.installationId === state.installationId && profile.ownerId === state.ownerId,
      "WALLET_RECOVERY_REQUIRED",
      "The pending recovery database identity changed.",
    );
    const putProfile = async (phase: "RECOVERING" | "READY") => {
      requireWallet(
        !cancel.aborted,
        "WALLET_OPERATION_ABORTED",
        "Installation recovery was canceled before profile publication.",
      );
      const bytes = Buffer.from(JSON.stringify({ ...profile, phase }));
      try {
        await protection.put("wallet-profile", bytes);
      } finally {
        bytes.fill(0);
      }
    };
    // Old and new normal entrypoints are fenced before any restored state is adopted.
    await putProfile("RECOVERING");
    owner = repository.isReady()
      ? await GuardedWalletState.open(repository, protection)
      : await GuardedWalletState.initialize(
          repository,
          protection,
          repository.issueInitialization(mode === "recover" ? "fresh" : "resume"),
        );
    requireWallet(
      owner.continuityValid(),
      "WALLET_RECOVERY_REQUIRED",
      "The pending recovery root has incomplete protected continuity. Preserve it and explicitly recover into another new directory.",
    );
    runtime = await WalletRuntime.start(owner, custody, chain, sources, undefined, input.paymentNetwork);
    const restored = await runtime.backups.restore(
      backup,
      password,
      { acceptVerifiedGrossOutflow },
      cancel,
    );
    requireWallet(
      restored.wallet.address.toLowerCase() === preflight.key.address.toLowerCase() &&
        restored.wallet.network === preflight.key.network,
      "BACKUP_IDENTITY_CONFLICT",
      "Restored key identity changed after preflight.",
    );
    lease.recoverBinding({
      directory,
      installationId: state.installationId,
      ownerId: state.ownerId,
      recoveryId: profile.recovery!.recoveryId,
    });
    await putProfile("READY");
    const close = runtime.close.bind(runtime);
    runtime.close = async () => {
      try {
        await close();
      } finally {
        lease.close();
      }
    };
    return runtime;
  } catch (error) {
    if (runtime) await runtime.close();
    else if (owner) await owner.close();
    else database?.close();
    lease.close();
    throw error;
  }
}
