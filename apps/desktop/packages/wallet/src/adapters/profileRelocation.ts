import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ProtectedStore } from "../app/ports.js";
import type { StateCommitment } from "../app/state.js";
import { protectedJson, rootMatches, sameCommitment, type RootRegistration } from "../app/commitments.js";
import { GuardedWalletState } from "../app/guardedState.js";
import { requireWallet } from "../domain/errors.js";
import { canonical, digest } from "./canonical.js";
import { WalletDatabase } from "./database.js";
import { acquireProfileLease } from "./profileLease.js";
import type { ProfileBinding, ProtectedProfile } from "./profileRecords.js";
import { SqliteWalletRepository } from "./repository.js";
import { copyRelocationBlobs, ensureRelocationTarget, privateRelocationDirectory,
  relocationBlobDigest, relocationDatabaseDigest } from "./relocationFiles.js";
import { publishProtectedRecord, readRelocationJournal, RELOCATION_ACCOUNT,
  RELOCATION_STAGES, type RelocationJournal } from "./relocationJournal.js";

/** Trusted maintenance entrypoint. It never starts a runtime or loads a signing key. */
export async function relocateWalletProfile(input: {
  sourceService: string;
  targetRoot: string;
  protection: ProtectedStore;
  afterWrite?: (boundary: string) => void;
}) {
  const { protection } = input;
  let journal = await readRelocationJournal(protection);
  const original = journal?.profile ?? await protectedJson<ProtectedProfile>(protection, "wallet-profile");
  requireWallet(original?.version === 1 && original.phase === "READY" &&
    /^[0-9a-f-]{36}$/.test(original.installationId), "WALLET_RELOCATION_REQUIRED",
  "Relocation requires the existing initialized protected wallet profile.");
  const source = journal?.source ?? original.directory;
  const target = join(input.targetRoot, "profiles", original.installationId);
  const sourceService = privateRelocationDirectory(input.sourceService);
  const targetService = privateRelocationDirectory(join(input.targetRoot, "service"), true);
  requireWallet(sourceService !== targetService && source !== target,
    "WALLET_RELOCATION_REQUIRED", "Relocation source and target must be distinct.");
  if (journal) requireWallet(journal.sourceService === sourceService &&
    journal.targetService === targetService && journal.target === target &&
    journal.source === original.directory,
  "WALLET_RELOCATION_REQUIRED", "Only the recorded relocation can resume.");
  const oldLease = acquireProfileLease(sourceService);
  let newLease: ReturnType<typeof acquireProfileLease> | undefined;
  let sourceDb: WalletDatabase | undefined, targetDb: WalletDatabase | undefined;
  try {
    newLease = acquireProfileLease(targetService);
    const finalProfile: ProtectedProfile = { version: 1, phase: "READY", directory: target,
      installationId: original.installationId, ownerId: original.ownerId };
    const targetBinding: ProfileBinding = { directory: target,
      installationId: original.installationId, ownerId: original.ownerId };
    if (journal?.stage === "COMPLETE") {
      requireWallet(canonical(await protectedJson(protection, "wallet-profile")) === canonical(finalProfile) &&
        canonical(newLease.readBinding()) === canonical(targetBinding) &&
        canonical(oldLease.readBinding()) === canonical({ ...targetBinding, recoveryId: journal.migrationId }),
      "WALLET_RELOCATION_REQUIRED", "The completed relocation registrations changed.");
      targetDb = WalletDatabase.openExisting(privateRelocationDirectory(target));
      const owner = await GuardedWalletState.open(new SqliteWalletRepository(targetDb), protection);
      try { requireWallet(owner.continuityValid(), "WALLET_RELOCATION_REQUIRED",
        "The relocated wallet no longer has protected continuity."); }
      finally { await owner.close(); targetDb = undefined; }
      return { migrationId: journal.migrationId, directory: target, installationId: original.installationId };
    }
    sourceDb = WalletDatabase.openExisting(privateRelocationDirectory(source));
    const repository = new SqliteWalletRepository(sourceDb);
    const state = repository.read(), sourceCommitment = repository.commitment(state);
    const root = await protectedJson<RootRegistration>(protection, "root:" + sourceCommitment.storageBinding);
    const external = await protectedJson<StateCommitment>(protection, "anchor:" + state.installationId);
    requireWallet(repository.isReady() && rootMatches(root, state, sourceCommitment.storageBinding) &&
      root?.phase === "READY" && sameCommitment(repository.readCommitment(), sourceCommitment) &&
      state.ownerId === original.ownerId && state.installationId === original.installationId,
    "WALLET_RELOCATION_REQUIRED", "Source wallet continuity or identity is invalid.");
    if (!journal) {
      requireWallet(sameCommitment(external, sourceCommitment) &&
        canonical(await protectedJson(protection, "wallet-profile")) === canonical(original),
      "WALLET_RELOCATION_REQUIRED", "The source profile changed before relocation admission.");
      const binding = oldLease.readBinding();
      requireWallet(binding?.directory === source && binding.ownerId === state.ownerId &&
        binding.installationId === state.installationId &&
        binding.recoveryId === original.recovery?.recoveryId,
      "WALLET_RELOCATION_REQUIRED", "Source service registration does not match the protected profile.");
      requireWallet(!newLease.hasHistory() && (!existsSync(target) ||
        (privateRelocationDirectory(target) && readdirSync(target).length === 0)),
      "WALLET_RELOCATION_REQUIRED", "The destination already owns wallet history.");
      journal = { version: 1, migrationId: randomUUID(), stage: "PREPARED", source,
        sourceService, target, targetService, profile: original, binding, root: root!,
        commitment: sourceCommitment, databaseDigest: relocationDatabaseDigest(sourceDb.connection),
        blobsDigest: relocationBlobDigest(join(source, "http-blobs")) };
      await publishProtectedRecord(protection, RELOCATION_ACCOUNT, journal, [null]);
      input.afterWrite?.("journal-PREPARED");
    }
    const record = journal;
    const barrier = { ...targetBinding, recoveryId: record.migrationId };
    const targetCommitment = repository.commitment(state, digest(target));
    const targetRoot: RootRegistration = { ...record.root, storageBinding: targetCommitment.storageBinding,
      initialCommitment: { ...record.root.initialCommitment, storageBinding: targetCommitment.storageBinding } };
    requireWallet(canonical(root) === canonical(record.root) &&
      sameCommitment(sourceCommitment, record.commitment) &&
      relocationDatabaseDigest(sourceDb.connection) === record.databaseDigest &&
      relocationBlobDigest(join(source, "http-blobs")) === record.blobsDigest &&
      (sameCommitment(external, sourceCommitment) || sameCommitment(external, targetCommitment)) &&
      [record.binding, barrier].some(value => canonical(value) === canonical(oldLease.readBinding())),
    "WALLET_RELOCATION_REQUIRED", "Relocation facts changed after preparation.");
    const currentProfile = await protectedJson(protection, "wallet-profile");
    requireWallet([original, finalProfile].some(value => canonical(value) === canonical(currentProfile)),
      "WALLET_RELOCATION_REQUIRED", "The protected profile changed during relocation.");
    const advance = async (stage: RelocationJournal["stage"]) => {
      if (RELOCATION_STAGES.indexOf(record.stage) >= RELOCATION_STAGES.indexOf(stage)) return;
      const next = { ...record, stage };
      await publishProtectedRecord(protection, RELOCATION_ACCOUNT, next, [{ ...record }]);
      record.stage = stage;
      input.afterWrite?.("journal-" + stage);
    };
    ensureRelocationTarget(target, record.migrationId);
    input.afterWrite?.("target-marker");
    targetDb = existsSync(join(target, "wallet.sqlite"))
      ? WalletDatabase.openExisting(target)
      : await sourceDb.snapshotForRelocation(target, record.migrationId);
    input.afterWrite?.("snapshot");
    const copied = new SqliteWalletRepository(targetDb);
    requireWallet(relocationDatabaseDigest(targetDb.connection) === record.databaseDigest &&
      (sameCommitment(copied.readCommitment(), sourceCommitment) ||
        sameCommitment(copied.readCommitment(), targetCommitment)) &&
      sameCommitment(copied.commitment(copied.read()), targetCommitment) &&
      rootMatches(targetRoot, copied.read(), targetCommitment.storageBinding),
    "WALLET_RELOCATION_REQUIRED", "The snapshot does not exactly preserve wallet history.");
    copyRelocationBlobs(join(source, "http-blobs"), join(target, "http-blobs"), record.blobsDigest);
    input.afterWrite?.("blobs");
    targetDb.transaction([{ sql: "UPDATE control_anchors SET document=? WHERE singleton=1",
      parameters: [canonical(targetCommitment)] }]);
    input.afterWrite?.("database-anchor");
    await advance("COPIED");
    await publishProtectedRecord(protection, "root:" + targetCommitment.storageBinding, targetRoot, [null]);
    input.afterWrite?.("target-root");
    await publishProtectedRecord(protection, "anchor:" + state.installationId,
      targetCommitment, [sourceCommitment]);
    input.afterWrite?.("external-anchor");
    await advance("ANCHORED");
    const existingTargetBinding = newLease.readBinding();
    requireWallet(existingTargetBinding === null || canonical(existingTargetBinding) === canonical(targetBinding),
      "WALLET_RELOCATION_REQUIRED", "The destination service registration changed.");
    if (existingTargetBinding === null) newLease.bind(targetBinding);
    input.afterWrite?.("target-binding");
    if (canonical(oldLease.readBinding()) !== canonical(barrier)) oldLease.recoverBinding(barrier);
    input.afterWrite?.("source-barrier");
    await publishProtectedRecord(protection, "wallet-profile", finalProfile, [original]);
    input.afterWrite?.("profile");
    await advance("SWITCHED");
    await advance("COMPLETE");
    return { migrationId: record.migrationId, directory: target, installationId: state.installationId };
  } finally {
    targetDb?.close();
    sourceDb?.close();
    newLease?.close();
    oldLease.close();
  }
}
