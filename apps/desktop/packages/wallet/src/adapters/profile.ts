import type { ProtectedProfile as Profile } from "./profileRecords.js";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { KeyCustody, ProtectedStore, WalletChain } from "../app/ports.js";
import type { ClockSources } from "../app/clock.js";
import { protectedJson } from "../app/commitments.js";
import { GuardedWalletState } from "../app/guardedState.js";
import { WalletRuntime } from "../app/runtime.js";
import { requireWallet, WalletError } from "../domain/errors.js";
import { WalletDatabase } from "./database.js";
import { SqliteWalletRepository } from "./repository.js";
import { acquireProfileLease } from "./profileLease.js";
import type { InitializationTicket } from "../app/state.js";
import { assertNoPendingRelocation } from "./relocationJournal.js";
// Dependency injection is internal. Production uses one OS-user lease and namespace.
export async function openWalletProfile(input: {
  freshGeneralSources?: boolean;
  paymentNetwork?: import("../domain/model.js").Network;
  directory?: string;
  installationId?: string;
  leaseDirectory: string;
  mode: "create" | "open" | "resume_setup";
  protection: ProtectedStore;
  custody: KeyCustody;
  chain: WalletChain;
  sources: ClockSources;
}): Promise<WalletRuntime> {
  requireWallet(
    (input.directory === undefined || isAbsolute(input.directory)) && isAbsolute(input.leaseDirectory),
    "UNSAFE_STORAGE_PATH",
    "Absolute wallet service directories are required.",
  );
  const lease = acquireProfileLease(input.leaseDirectory),
    release = () => lease.close();
  let database: WalletDatabase | undefined;
  let owner: GuardedWalletState | undefined;
  try {
    await assertNoPendingRelocation(input.protection);
    const profile = await protectedJson<Profile>(input.protection, "wallet-profile");
    const binding = lease.readBinding();
    // A pristine installation has no protected profile, no service registration and no history.
    // This is first-run state, not a recovery condition; any leftover record still requires recovery.
    if (input.mode === "open" && profile === null && binding === null && !lease.hasHistory() &&
      (input.directory === undefined || !existsSync(input.directory)))
      throw new WalletError("WALLET_PROFILE_ABSENT", "No wallet profile exists for this installation.");
    const requested = input.directory ?? profile?.directory ??
      (input.mode === "resume_setup" ? binding?.directory : undefined);
    requireWallet(requested && isAbsolute(requested), "WALLET_RECOVERY_REQUIRED",
      "The original wallet directory registration is required.");
    requireWallet(
      input.mode !== "resume_setup" || (!binding?.recoveryId && !profile?.recovery),
      "WALLET_RECOVERY_REQUIRED",
      "Installation recovery cannot use the first-setup entrypoint.",
    );
    if (binding?.recoveryId || profile?.recovery)
      requireWallet(
        binding?.recoveryId === profile?.recovery?.recoveryId,
        "WALLET_RECOVERY_REQUIRED",
        "The directory recovery identity does not match the protected profile.",
      );
    if (input.mode === "create") {
      requireWallet(
        profile === null && !lease.hasHistory(),
        "WALLET_RECOVERY_REQUIRED",
        "This OS profile already owns a wallet. Existing history must be opened or explicitly recovered.",
      );
      mkdirSync(requested, { recursive: true, mode: 0o700 });
    }
    const directory = realpathSync(requested);
    if (input.mode !== "create")
      requireWallet(
        (binding === null ? input.mode === "resume_setup" : binding.directory === directory) &&
          (profile === null
            ? input.mode === "resume_setup"
            : profile.version === 1 && profile.directory === directory),
        "WALLET_RECOVERY_REQUIRED",
        "The wallet directory does not match this protected profile.",
      );
    database =
      input.mode === "create"
        ? input.freshGeneralSources ? WalletDatabase.createWithGeneralSources(directory, input.installationId) : WalletDatabase.create(directory, input.installationId)
        : WalletDatabase.openExisting(directory);
    const repository = new SqliteWalletRepository(database),
      state = repository.read();
    let resumeTicket: InitializationTicket | undefined;
    if (binding)
      requireWallet(
        binding.installationId === state.installationId && binding.ownerId === state.ownerId,
        "WALLET_RECOVERY_REQUIRED",
        "The service registration and database identities disagree.",
      );
    if (profile)
      requireWallet(
        profile.installationId === state.installationId && profile.ownerId === state.ownerId,
        "WALLET_RECOVERY_REQUIRED",
        "The protected profile and database identities disagree.",
      );
    if (!binding) {
      if (input.mode !== "create") {
        requireWallet(
          profile === null || profile.phase === "REGISTERED",
          "WALLET_RECOVERY_REQUIRED",
          "A missing service registration cannot be recreated for an active wallet.",
        );
        resumeTicket = repository.issueInitialization("resume");
      }
      lease.bind({ directory, installationId: state.installationId, ownerId: state.ownerId });
    }
    const registration: Profile = profile ?? {
      version: 1,
      directory,
      installationId: state.installationId,
      ownerId: state.ownerId,
      phase: "REGISTERED",
    };
    const put = async (value: Profile) => {
      const bytes = Buffer.from(JSON.stringify(value));
      try {
        await input.protection.put("wallet-profile", bytes);
      } finally {
        bytes.fill(0);
      }
    };
    if (input.mode === "create") await put(registration);
    if (input.mode === "resume_setup" && profile === null) {
      // Validate the complete pristine schema before recreating this pending setup record.
      const ticket = resumeTicket ?? repository.issueInitialization("resume");
      await put(registration);
      owner = await GuardedWalletState.initialize(repository, input.protection, ticket);
      await put({ ...registration, phase: "READY" });
    } else if (input.mode === "open") {
      requireWallet(
        profile?.phase === "READY",
        "WALLET_RECOVERY_REQUIRED",
        "Pending setup requires the explicit setup recovery entrypoint.",
      );
      owner = await GuardedWalletState.open(repository, input.protection);
    } else {
      // A finished DB may only advance its matching REGISTERED profile to READY.
      if (repository.isReady() && input.mode === "resume_setup") {
        requireWallet(
          registration.phase === "REGISTERED",
          "WALLET_RECOVERY_REQUIRED",
          "A ready profile cannot be initialized again.",
        );
        owner = await GuardedWalletState.open(repository, input.protection);
        requireWallet(
          owner.continuityValid() &&
            owner.snapshot().revision === 1 &&
            owner.snapshot().wallets.length === 0,
          "WALLET_RECOVERY_REQUIRED",
          "Only the same empty setup may finish forward.",
        );
      } else
        owner = await GuardedWalletState.initialize(
          repository,
          input.protection,
          resumeTicket ??
            repository.issueInitialization(input.mode === "create" ? "fresh" : "resume"),
        );
      await put({ ...registration, phase: "READY" });
    }
    const runtime = await WalletRuntime.start(owner, input.custody, input.chain, input.sources, {
      ready: () => database!.schemaVersion === 5, upgrade: () => database!.upgradeGeneralSources(),
    }, input.paymentNetwork);
    const close = runtime.close.bind(runtime);
    runtime.close = async () => {
      try {
        await close();
      } finally {
        release();
      }
    };
    return runtime;
  } catch (error) {
    if (owner) await owner.close();
    else database?.close();
    release();
    throw error;
  }
}
