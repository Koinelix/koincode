import { desktopClientScopeIsStale, synchronizeDesktopClientScope } from "./desktopClient.js";
import type { GeneralManagedKey } from "./ports.js";
import type { RuntimeContext } from "./runtimeContext.js";
import { attachGeneralPaymentSource } from "./generalPaymentBindings.js";
import { audit } from "./runtimeContext.js";
import { requireWallet } from "../domain/errors.js";

/** Original controls, state, chain baseline and budget subjects; no second payment ledger. */
export function registerLocalPaymentSource(ctx: RuntimeContext, key: GeneralManagedKey, signal: AbortSignal): Promise<
  { status: "connected"; walletId: string } | { status: "needs_upgrade" }> {
  requireWallet(key.kind === "general_source" && key.source.protection === "local_system" && key.network === ctx.paymentNetwork,
    "GENERAL_ACCOUNT_UNAVAILABLE", "An actual local source on the fixed payment network is required.");
  const frozen = structuredClone(key);
  return ctx.controls.run(async () => {
    requireWallet(ctx.state.continuityValid() && !signal.aborted, "WALLET_OPERATION_ABORTED", "Source registration is unavailable.");
    if (!ctx.generalSources?.ready()) return { status: "needs_upgrade" };
    const previous = ctx.state.snapshot().wallets.find((wallet) => wallet.kind === "general_source" &&
      wallet.source.sourceId === frozen.source.sourceId && wallet.source.installationId === frozen.source.installationId);
    if (previous) {
      requireWallet(previous.kind === "general_source" && Object.keys(previous.source).length === Object.keys(frozen.source).length &&
        (Object.keys(frozen.source) as (keyof typeof frozen.source)[]).every((field) => previous.source[field] === frozen.source[field]) &&
        previous.address === frozen.address, "GENERAL_SOURCE_BINDING_CONFLICT", "The original source binding changed.");
      if (desktopClientScopeIsStale(ctx.state.snapshot())) await ctx.state.mutate(state => {
        requireWallet(!signal.aborted && !ctx.fence.signal.aborted, "WALLET_OPERATION_ABORTED", "Source registration was canceled.");
        synchronizeDesktopClientScope(state);
      });
      return { status: "connected", walletId: previous.walletId };
    }
    const snapshot = await ctx.chain.snapshot(frozen.network, frozen.address, signal);
    const now = ctx.clock.update(snapshot.latest.timestamp, ctx.state.snapshot().trustedTime);
    const walletId = await ctx.state.mutate((state) => {
      requireWallet(!signal.aborted && !ctx.fence.signal.aborted, "WALLET_OPERATION_ABORTED", "Source registration was canceled.");
      const wallet = attachGeneralPaymentSource(state, frozen, { blockNumber: snapshot.latest.number, blockHash: snapshot.latest.hash });
      state.trustedTime = Math.max(state.trustedTime, now);
      audit(state, "WALLET_ENROLLED", wallet.subjectId, { baselineBlock: wallet.baselineBlock });
      return wallet.walletId;
    });
    return { status: "connected", walletId };
  });
}
