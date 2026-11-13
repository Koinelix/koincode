import { keccak256 } from "ethers";

import { randomUUID } from "node:crypto";
import { networkConfig } from "../domain/networks.js";
import { atomic } from "../domain/atomic.js";
import { allowanceData, verifySignedAllowance, type AllowanceTransaction } from "../domain/allowanceTransaction.js";
import { requireWallet } from "../domain/errors.js";
import { PERMIT2_ADDRESS } from "../domain/uptoAuthorization.js";
import { uptoAvailability } from "../domain/uptoScheduling.js";
import { audit, walletRecord, type RuntimeContext } from "./runtimeContext.js";
import type { ProtectedStore, UptoChainSnapshot } from "./ports.js";
import type { WalletState, WalletRecord } from "./state.js";

export function pendingAllowanceChange(state: WalletState, subjectId: string) {
  const event = state.auditEvents.findLast(e => e.subjectId === subjectId &&
    (e.action === "ALLOWANCE_TX_PREPARED" || e.action === "ALLOWANCE_NONCE_FINALIZED"));
  if (!event || event.action === "ALLOWANCE_NONCE_FINALIZED") return;
  const { hash, nonce, amountAtomic } = event.details;
  requireWallet(typeof hash === "string" && /^0x[0-9a-f]{64}$/.test(hash) && typeof nonce === "number" &&
    Number.isSafeInteger(nonce) && nonce >= 0 && typeof amountAtomic === "string", "LEDGER_CORRUPT", "Invalid approval journal.");
  atomic(amountAtomic);
  return { hash, nonce, amountAtomic };
}
export async function refreshAllowanceChange(ctx: RuntimeContext, wallet: WalletRecord, signal: AbortSignal, onRead?: (active: boolean) => void) {
  const pending = pendingAllowanceChange(ctx.state.snapshot(), wallet.subjectId);
  if (!pending) return;
  const rpc = ctx.chain.allowanceTransactions;
  requireWallet(rpc, "ALLOWANCE_UNAVAILABLE", "The approval network is unavailable.");
  onRead?.(true);
  const nonce = await rpc.finalizedNonce(wallet.network, wallet.address, signal).finally(() => onRead?.(false));
  if (nonce <= pending.nonce) return;
  await ctx.state.mutate(state => {
    if (pendingAllowanceChange(state, wallet.subjectId)?.hash === pending.hash) audit(state, "ALLOWANCE_NONCE_FINALIZED", wallet.subjectId, { hash: pending.hash });
  });
}
export function cappedAllowance(snapshot: UptoChainSnapshot, pending: ReturnType<typeof pendingAllowanceChange>) {
  const cap = pending?.amountAtomic;
  return cap !== undefined && BigInt(cap) < BigInt(snapshot.allowanceAtomic) ? { ...snapshot, allowanceAtomic: cap } : snapshot;
}
type Preview = { id: string; walletId: string; tx: AllowanceTransaction; feeWei: string; original: string; expires: number; epoch: number };

/** Only the authenticated desktop management path can consume a preview. */
export class WalletAllowance {
  private preview?: Preview;
  constructor(private readonly ctx: RuntimeContext, private readonly protection: ProtectedStore,
    private readonly unsigned: (walletId: string, ids: ReadonlySet<string>) => { total: bigint; quotes: string[] }) {}
  private async observe(walletId: string, signal: AbortSignal, finalized = true) {
    const { state, chain } = this.ctx;
    requireWallet(state.continuityValid() && state.snapshot().defaultWalletId === walletId, "PAYMENT_CONTEXT_CHANGED", "The selected wallet changed.");
    let wallet = walletRecord(state.snapshot(), walletId);
    await refreshAllowanceChange(this.ctx, wallet, signal);
    wallet = walletRecord(state.snapshot(), walletId);
    requireWallet(wallet.asset === networkConfig(wallet.network).asset, "PAYMENT_NETWORK_MISMATCH", "The wallet asset differs from the configured USDC.");
    requireWallet(chain.uptoSnapshot && chain.allowanceTransactions, "ALLOWANCE_UNAVAILABLE", "The approval network is unavailable.");
    const candidates = state.snapshot().intents.filter(i => i.subjectId === wallet.subjectId && i.upto && i.status !== "FAILED_UNSIGNED");
    // Large histories need a finalized time bound before selecting live nonces.
    const baseline = finalized || candidates.length > 1024 ? await chain.uptoSnapshot(wallet.network, wallet.address, [], signal) : undefined;
    const live = baseline ? candidates.filter(i => i.validBefore >= baseline.finalized.timestamp) : candidates;
    const proof = baseline && !live.length ? baseline : await chain.uptoSnapshot(wallet.network, wallet.address,
      live.map(i => i.nonce), signal, finalized ? "finalized" : "latest");
    const snapshot = finalized && baseline ? baseline : proof;
    const current = state.snapshot();
    requireWallet(current.defaultWalletId === walletId && current.subjects.some(s => s.subjectId === wallet.subjectId &&
      !s.recoveryRequired && !s.signingPaused), "PAYMENT_CONTEXT_CHANGED", "The selected wallet is unavailable.");
    const existing = current.intents.filter(i => i.subjectId === wallet.subjectId && i.upto);
    const observation = { ...proof, finalizedTimestamp: proof.finalized.timestamp };
    const { inFlightAtomic } = uptoAvailability(existing, observation);
    // A waived payment can still carry a consumable EIP-2612 signature.
    const livePermit = existing.some(i => i.status !== "FAILED_UNSIGNED" && i.upto!.permitNonce !== null &&
      BigInt(i.upto!.permitNonce!) >= BigInt(proof.permitNonce) && i.validBefore >= observation.finalizedTimestamp);
    const unsigned = this.unsigned(walletId, new Set(existing.map(i => i.intentId)));
    const used = new Set(proof.usedNonces);
    const liveSignature = existing.some(i => i.status !== "FAILED_UNSIGNED" && i.validBefore >= proof.finalized.timestamp && !used.has(i.nonce));
    const inFlight = inFlightAtomic + unsigned.total;
    return { wallet, pending: pendingAllowanceChange(current, wallet.subjectId), quotes: unsigned.quotes, rpc: chain.allowanceTransactions,
      allowance: snapshot.allowanceAtomic, inFlight: inFlight.toString(), busy: livePermit || liveSignature || inFlight > 0n, balance: snapshot.balanceAtomic };
  }
  async inspect(walletId: string, amount?: string) {
    const epoch = this.ctx.fence.capture(), signal = AbortSignal.any([this.ctx.fence.signal, this.ctx.unlocks.hostContextSignal, AbortSignal.timeout(30000)]);
    const { wallet, rpc, allowance, inFlight, busy, balance, pending, quotes } = await this.observe(walletId, signal, amount !== undefined);
    const info = { address: wallet.address, network: wallet.network, spender: PERMIT2_ADDRESS, allowance, inFlight, busy, balance,
      quotes, pendingHash: pending?.hash ?? null };
    if (amount === undefined) return info;
    allowanceData(amount);
    requireWallet(!busy && !pending, "ALLOWANCE_TX_PENDING", "Wait for outstanding authorizations to finish.");
    requireWallet(amount !== allowance, "ALLOWANCE_UNCHANGED", "This allowance is already set.");
    const { tx, feeWei, hasGas } = await rpc.quote(wallet.network, wallet.address, amount, signal);
    this.ctx.fence.assertCurrent(epoch);
    requireWallet(hasGas, "ALLOWANCE_GAS_REQUIRED", "The selected account needs ETH for the Base network fee.");
    const id = randomUUID();
    this.preview = { id, walletId, tx, feeWei, original: allowance, expires: performance.now() + 60000, epoch };
    return { ...info, id, feeWei, amount };
  }
  async confirm(walletId: string, id: string) {
    const p = this.preview;
    requireWallet(p?.id === id && p.walletId === walletId, "ALLOWANCE_PREVIEW_EXPIRED", "Preview the allowance again.");
    this.preview = undefined;
    this.ctx.fence.assertCurrent(p.epoch);
    const interaction = this.ctx.unlocks.interactionGeneration;
    const cancel = AbortSignal.any([this.ctx.fence.signal, this.ctx.unlocks.hostContextSignal, this.ctx.state.walletSelectionSignal, AbortSignal.timeout(30000)]);
    const current = () => {
      cancel.throwIfAborted();
      requireWallet(performance.now() < p.expires && this.ctx.unlocks.interactionGeneration === interaction &&
        this.ctx.state.snapshot().defaultWalletId === walletId, "ALLOWANCE_PREVIEW_EXPIRED", "Preview the allowance again.");
    };
    return this.ctx.controls.run(async () => {
      const { wallet, rpc, allowance, busy, pending } = await this.observe(walletId, cancel);
      requireWallet(!busy && !pending && allowance === p.original && this.ctx.custody.signAllowance,
        "ALLOWANCE_PREVIEW_EXPIRED", "The wallet or its allowance changed.");
      const fresh = await rpc.quote(wallet.network, wallet.address, p.tx.amountAtomic, cancel);
      requireWallet(fresh.hasGas && fresh.tx.nonce === p.tx.nonce && atomic(fresh.tx.gasLimit) <= atomic(p.tx.gasLimit) &&
        atomic(fresh.tx.gasPrice) <= atomic(p.tx.gasPrice) && atomic(fresh.feeWei) <= atomic(p.feeWei),
        "ALLOWANCE_PREVIEW_EXPIRED", "The nonce or network fee changed.");
      current();
      const raw = await this.ctx.custody.signAllowance(wallet, fresh.tx, cancel);
      const hash = verifySignedAllowance(raw, fresh.tx);
      current();
      await this.protection.put("allowance-tx:" + hash, Buffer.from(raw));
      current();
      await this.ctx.state.mutate(state => {
        requireWallet(!pendingAllowanceChange(state, wallet.subjectId), "ALLOWANCE_TX_PENDING", "An allowance change is pending.");
        audit(state, "ALLOWANCE_TX_PREPARED", wallet.subjectId, { hash, nonce: fresh.tx.nonce, amountAtomic: fresh.tx.amountAtomic });
      });
      current();
      return this.send(wallet.network, raw, hash, cancel);
    });
  }
  async resend(walletId: string, hash: string) {
    const signal = AbortSignal.any([this.ctx.fence.signal, this.ctx.unlocks.hostContextSignal, this.ctx.state.walletSelectionSignal, AbortSignal.timeout(15000)]);
    const { wallet, pending } = await this.observe(walletId, signal);
    requireWallet(pending?.hash === hash, "ALLOWANCE_PREVIEW_EXPIRED", "The recorded transaction changed.");
    const bytes = await this.protection.get("allowance-tx:" + hash);
    requireWallet(bytes, "ALLOWANCE_UNAVAILABLE", "The recorded transaction is unavailable.");
    try {
      const raw = Buffer.from(bytes).toString();
      requireWallet(keccak256(raw) === hash, "ALLOWANCE_UNAVAILABLE", "The recorded transaction is invalid.");
      signal.throwIfAborted();
      return this.send(wallet.network, raw, hash, signal);
    } finally { bytes.fill(0); }
  }
  private async send(network: WalletRecord["network"], raw: string, hash: string, signal: AbortSignal) {
    try {
      const observed = await this.ctx.chain.allowanceTransactions!.broadcast(network, raw, signal);
      return { hash, status: observed.toLowerCase() === hash ? "submitted" : "unknown" };
    } catch { return { hash, status: "unknown" }; }
  }
}
