import { createHash } from "node:crypto";
import { requireWallet } from "../domain/errors.js";
import { walletRecord, type RuntimeContext } from "./runtimeContext.js";

export function listLocalLegacyAccounts(ctx: RuntimeContext) {
  requireWallet(ctx.state.continuityValid(), "STORAGE_CONTINUITY_UNKNOWN", "The original wallet state is unavailable.");
  return ctx.state.snapshot().wallets.filter((wallet) => wallet.kind !== "general_source").map((wallet) => ({
    sourceId: wallet.walletId, address: wallet.address.toLowerCase(), sourceType: "private_key" as const, backupVerified: false,
  }));
}

/** Private desktop management only. Authentication precedes the original protected-key read. */
export async function revealLocalLegacyKey(ctx: RuntimeContext, walletId: string,
  authorize: (binding: { operationDigest: string; address: string }, signal: AbortSignal) => Promise<boolean>, signal: AbortSignal): Promise<{ format: "private_key"; privateKey: string }> {
  const generation = ctx.fence.capture(), initial = ctx.state.snapshot(), wallet = walletRecord(initial, walletId);
  requireWallet(ctx.state.continuityValid() && wallet.kind !== "general_source" && ctx.custody.revealPrivateKey,
    "GENERAL_ACCOUNT_UNAVAILABLE", "The original private-key source is unavailable.");
  const cancel = AbortSignal.any([signal, ctx.fence.signal]);
  const operationDigest = createHash("sha256").update(JSON.stringify(["local-legacy-export-v1", initial.ownerId,
    initial.installationId, wallet, "private_key"])).digest("hex");
  requireWallet(await authorize({ operationDigest, address: wallet.address.toLowerCase() }, cancel),
    "GENERAL_AUTH_REQUIRED", "System authentication is required.");
  const current = () => {
    ctx.fence.assertCurrent(generation);
    requireWallet(!cancel.aborted && ctx.state.continuityValid() &&
      JSON.stringify(walletRecord(ctx.state.snapshot(), walletId)) === JSON.stringify(wallet),
    "GENERAL_OPERATION_CANCELED", "The original export context changed.");
  };
  current(); const privateKey = await ctx.custody.revealPrivateKey(wallet, cancel); current();
  return { format: "private_key", privateKey };
}
