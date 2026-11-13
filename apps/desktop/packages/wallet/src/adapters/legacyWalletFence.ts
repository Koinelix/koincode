import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { ProtectedStore } from "../app/ports.js";
import { protectedJson } from "../app/commitments.js";
import { requireWallet } from "../domain/errors.js";
import { acquireWalletWriter } from "./database.js";
import { acquireProfileLease } from "./profileLease.js";
import type { ProtectedProfile } from "./profileRecords.js";
import { canonical } from "./canonical.js";
import { privateRelocationDirectory } from "./relocationFiles.js";
import { assertNoPendingRelocation } from "./relocationJournal.js";

function inside(root: string, directory: string): boolean {
  const back = relative(root, directory);
  return back !== "" && !back.startsWith("..") && !isAbsolute(back);
}

/** Existing installations share their original service fence for the full new runtime lifetime. */
export async function withLegacyWalletFence<T extends { close(): Promise<void> }>(input: {
  legacyRoot: string;
  targetRoot: string;
  mode: "create" | "open" | "resume_setup" | "recover" | "resume_recovery";
  protection: ProtectedStore;
}, action: () => Promise<T>): Promise<T> {
  if (!existsSync(input.legacyRoot)) return action();
  privateRelocationDirectory(input.legacyRoot);
  const lease = acquireProfileLease(join(input.legacyRoot, "service"));
  let writer: ReturnType<typeof acquireWalletWriter> | undefined;
  let runtime: T | undefined;
  try {
    await assertNoPendingRelocation(input.protection);
    const history = lease.hasHistory() || readdirSync(input.legacyRoot).some(name => name !== "service");
    let profile: ProtectedProfile | null;
    try { profile = await protectedJson<ProtectedProfile>(input.protection, "wallet-profile"); }
    catch (error) {
      // Explicit backup recovery must remain available for damaged protected profiles.
      if (input.mode !== "recover") throw error;
      profile = null;
    }
    const recovering = input.mode === "recover" || input.mode === "resume_recovery";
    if (input.mode !== "recover") requireWallet(
      profile ? inside(input.targetRoot, profile.directory) : !history,
      "WALLET_RELOCATION_REQUIRED", "Existing legacy wallet history requires explicit relocation or backup recovery.",
    );
    const binding = lease.readBinding();
    const permanentlyFenced = binding?.recoveryId && profile &&
      binding.directory === profile.directory && binding.recoveryId !== profile.recovery?.recoveryId &&
      inside(input.targetRoot, profile.directory);
    if (recovering && binding && !permanentlyFenced && existsSync(binding.directory)) {
      // Only the writer lease is read: a damaged ledger must still be recoverable from a backup.
      writer = acquireWalletWriter(privateRelocationDirectory(binding.directory));
    }
    runtime = await action();
    if (history) {
      const current = await protectedJson<ProtectedProfile>(input.protection, "wallet-profile");
      requireWallet(current?.phase === "READY" && inside(input.targetRoot, current.directory),
        "WALLET_RECOVERY_REQUIRED", "Recovery must finish in the selected wallet namespace.");
      if (!permanentlyFenced || recovering) {
        const barrier = { directory: current.directory, installationId: current.installationId,
          ownerId: current.ownerId, recoveryId: randomUUID() };
        try { lease.recoverBinding(barrier); }
        catch (error) { if (canonical(lease.readBinding()) !== canonical(barrier)) throw error; }
      }
    }
    const close = runtime.close.bind(runtime);
    let closing: Promise<void> | undefined;
    runtime.close = () => closing ??= close().finally(() => {
      try { writer?.close(); } finally { lease.close(); }
    });
    return runtime;
  } catch (error) {
    try { await runtime?.close(); }
    finally { try { writer?.close(); } finally { lease.close(); } }
    throw error;
  }
}
