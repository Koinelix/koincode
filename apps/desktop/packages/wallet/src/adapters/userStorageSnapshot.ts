import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import type { ProtectedStore } from "../app/ports.js";
import { protectedJson, rootMatches, sameCommitment, type RootRegistration } from "../app/commitments.js";
import type { StateCommitment } from "../app/state.js";
import { requireWallet } from "../domain/errors.js";
import { assertGeneralSigningInventory } from "../domain/generalSigningInventory.js";
import { canonical, digest } from "./canonical.js";
import { WalletDatabase } from "./database.js";
import { SqliteWalletRepository } from "./repository.js";
import { acquireProfileLease } from "./profileLease.js";
import type { ProtectedProfile } from "./profileRecords.js";
import { readGeneralStateCheckpoint } from "./generalGuardedState.js";
import { SqliteGeneralStateRepository } from "./generalStateRepository.js";
import { SqliteGeneralSigningJournalRepository } from "./generalSigningJournalRepository.js";
import { inspectGeneralSigningRegistry, parseGeneralSigningCheckpoint } from "./generalSigningJournal.js";
import type { FrozenUserStorage } from "./userStorageMigration.js";
import { type UserStorageNamespace } from "./userKeychain.js";

function consistent(value: unknown): asserts value { requireWallet(value, "WALLET_STORAGE_MIGRATION_CONFLICT", "Original wallet continuity must verify before migration."); }
/** Holds the original service, DB, general and journal writer leases in fixed order. */
export async function freezeUserStorage(legacy: Record<UserStorageNamespace, ProtectedStore>, domains: UserStorageNamespace[], root = join(homedir(), ".koincode/wallet")): Promise<FrozenUserStorage> {
  const closers: Array<() => void> = [];
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    let failed: unknown;
    for (const release of closers.reverse()) try { release(); } catch (error) { failed ??= error; }
    if (failed) throw failed;
  };
  try {
    const payments = domains.filter(n => n !== "general").map(namespace => {
      const directory = join(root, namespace), lease = acquireProfileLease(join(directory, "service"));
      closers.push(() => lease.close()); return { namespace, directory, lease };
    }).map(item => {
      const binding = item.lease.readBinding();
      if (!binding) { consistent(!item.lease.hasHistory()); return { ...item, binding, database: null, repository: null }; }
      const child = relative(item.directory, binding.directory);
      consistent(child && !isAbsolute(child) && !child.startsWith(".."));
      const database = WalletDatabase.openExisting(binding.directory); closers.push(() => database.close());
      return { ...item, binding, database, repository: new SqliteWalletRepository(database) };
    });
    const generalDirectory = join(root, "general-local");
    const general = domains.includes("general") && existsSync(generalDirectory) ? SqliteGeneralStateRepository.open(generalDirectory, "open") : null;
    if (general) closers.push(() => general.close());
    const history = general ? SqliteGeneralSigningJournalRepository.open(join(generalDirectory, "history"), "open") : null;
    if (history) closers.push(() => history.close());
    return { legacy, close, prepareActivation() {
      consistent(!closed);
      for (const { database } of payments) if (database?.schemaVersion === 4) database.upgradeGeneralSources();
    }, async inspect(stores) {
      consistent(!closed);
      const snapshots: unknown[] = [], fences: Array<{ namespace: UserStorageNamespace; account: string }> = [];
      for (const { namespace, binding, repository } of payments) {
        const profile = await protectedJson<ProtectedProfile>(stores[namespace], "wallet-profile");
        if (!repository || !binding) { consistent(profile === null); continue; }
        const state = repository.read(), actual = repository.commitment(state), stored = repository.readCommitment();
        const anchor = await protectedJson<StateCommitment>(stores[namespace], `anchor:${state.installationId}`);
        const registration = await protectedJson<RootRegistration>(stores[namespace], `root:${actual.storageBinding}`);
        consistent(profile?.version === 1 && profile.phase === "READY" && profile.directory === binding.directory &&
          profile.ownerId === binding.ownerId && profile.installationId === binding.installationId &&
          state.ownerId === binding.ownerId && state.installationId === binding.installationId && repository.isReady() &&
          rootMatches(registration, state, actual.storageBinding) && registration?.phase === "READY" &&
          sameCommitment(actual, stored) && sameCommitment(stored, anchor));
        snapshots.push({ namespace, profile, actual, state }); fences.push({ namespace, account: "wallet-profile" });
      }
      const generalStore = { get: (account: string) => stores.general.get(`local-v1:${account}`) };
      const state = domains.includes("general") ? await readGeneralStateCheckpoint(generalStore) : null;
      if (!general || !history) consistent(state === null);
      else {
        consistent(state && digest(general.read()) === digest(state));
        const registry = inspectGeneralSigningRegistry(await protectedJson(generalStore, "general-signing-registry-v1"));
        consistent(registry && registry.ownerId === state.ownerId && registry.installationId === state.installationId);
        assertGeneralSigningInventory(registry.streams, history.listStreams());
        const snapshot = { format: "koincode-general-signing-checkpoint", version: 1, ownerId: registry.ownerId,
          installationId: registry.installationId, domainId: registry.domainId, signingPolicyVersion: registry.signingPolicyVersion,
          signingPolicyDigest: registry.signingPolicyDigest,
          streams: registry.streams.map(stream => ({ ...stream, events: history.read(stream.id) })) };
        parseGeneralSigningCheckpoint(Buffer.from(canonical(snapshot)));
        snapshots.push({ namespace: "general", state, registry, snapshot });
        fences.push({ namespace: "general", account: "local-v1:general-state-v1" });
      }
      consistent(!closed && snapshots.length > 0);
      return { digest: digest(snapshots), fences };
    } };
  } catch (error) { close(); throw error; }
}
