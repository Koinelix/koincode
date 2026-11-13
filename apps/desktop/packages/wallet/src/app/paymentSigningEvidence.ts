import { AllowanceWait, uptoValidAfter } from "./uptoPreparation.js";
import { uptoAvailability, type ModelDirectPayment } from "../domain/uptoScheduling.js";
import type { UptoAuthorization } from "../domain/uptoAuthorization.js";
import { requireWallet, WalletError } from "../domain/errors.js";
import type { PaymentIntent, PaymentScope } from "../domain/model.js";
import { recordWaiverContradiction, type RuntimeContext } from "./runtimeContext.js";
import type { WalletRecord, WalletState } from "./state.js";
import type { ChainSnapshot, UptoChainSnapshot } from "./ports.js";
import { outstandingAtSnapshot, proveSettlementAnchors } from "./settlementProof.js";
import { paymentStage } from "./paymentTiming.js";

export async function checkWaivedNonces(ctx: RuntimeContext, intents: readonly PaymentIntent[], nonces: readonly string[]) {
  const used = new Set(nonces);
  const contradicted = intents.filter(i => i.schedulingRelease?.kind === "waived" && used.has(i.nonce));
  if (!contradicted.length) return;
  await ctx.state.mutate(state => {
    for (const old of contradicted) {
      const intent = state.intents.find(i => i.intentId === old.intentId);
      recordWaiverContradiction(state, intent);
    }
  });
  throw new WalletError("PAYMENT_WAIVER_BROKEN", "An authorization waived by the platform was used on chain. Check payment history.");
}

// An observed finalized time only narrows nonce reads. Funds and allowance still come from the new snapshot.
const finalizedTimeByWallet = new WeakMap<RuntimeContext, Map<string, number>>();

export function needsSettlementCheck(intent: PaymentIntent, finalizedTime: number) {
  return intent.schedulingRelease?.kind === "settled" &&
    (intent.status !== "CONFIRMED" || !intent.spent || intent.reserved || intent.validBefore >= finalizedTime);
}

function releasedWaiver(intent: PaymentIntent) {
  return intent.schedulingRelease?.kind === "waived" && intent.status === "EXPIRED_UNSETTLED" && !intent.reserved && !intent.spent && !intent.waiverContradicted &&
    intent.proofBlock !== undefined && !!intent.proofHash;
}

function expiredWaiverCovered(intent: PaymentIntent, snapshot: UptoChainSnapshot, used: ReadonlySet<string>) {
  return releasedWaiver(intent) && intent.proofBlock! <= snapshot.finalized.number &&
    snapshot.finalized.timestamp > intent.validBefore && checkedWaivers.get(snapshot)?.has(intent.nonce) && !used.has(intent.nonce);
}

const checkedWaivers = new WeakMap<UptoChainSnapshot, ReadonlySet<string>>();

export async function paymentSnapshot(ctx: RuntimeContext, wallet: WalletRecord, intents: readonly PaymentIntent[], signal?: AbortSignal, onRead?: (active: boolean) => void) {
  const times = finalizedTimeByWallet.get(ctx) ?? new Map<string, number>();
  finalizedTimeByWallet.set(ctx, times);
  const candidates = intents.filter(i => i.subjectId === wallet.subjectId && i.upto && i.status !== "FAILED_UNSIGNED");
  const select = (cutoff: number) => candidates.filter(i => i.validBefore >= cutoff ||
    (i.schedulingRelease?.kind === "waived" && !releasedWaiver(i)) || needsSettlementCheck(i, cutoff));
  const read = (items: readonly PaymentIntent[]) => {
    onRead?.(true);
    return ctx.chain.uptoSnapshot!(wallet.network, wallet.address, items.map(i => i.nonce), signal).finally(() => onRead?.(false));
  };
  let cutoff = times.get(wallet.subjectId) ?? 0;
  let needed = select(cutoff);
  let baseline: UptoChainSnapshot | undefined;
  if (needed.length > 1024 || (!cutoff && candidates.some(i => releasedWaiver(i) || i.status === "CONFIRMED"))) {
    baseline = await read([]);
    cutoff = baseline.finalized.timestamp;
    needed = select(cutoff);
  }
  let result = !needed.length && baseline ? baseline : await read(needed);
  if (needed.length !== candidates.length && result.finalized.timestamp < cutoff) {
    cutoff = result.finalized.timestamp;
    needed = select(cutoff);
    result = await read(needed);
    if (result.finalized.timestamp < cutoff) throw new WalletError("RPC_EVIDENCE_INVALID", "Finalized time moved backwards during allowance verification.");
  }
  const checked = new Set(needed.filter(i => i.schedulingRelease?.kind === "waived").map(i => i.nonce));
  const retired = candidates.filter(i => releasedWaiver(i) && !checked.has(i.nonce));
  if (retired.length) {
    // A canonical finalized non-use proof covers the original nonce beyond expiry.
    const verify = async (snap: UptoChainSnapshot) => {
      const eligible = retired.filter(i => i.proofBlock! <= snap.finalized.number);
      const anchors = new Map(eligible.map(i => [i.proofBlock! + ":" + i.proofHash!.toLowerCase(),
        { number: i.proofBlock!, hash: i.proofHash!.toLowerCase() }]));
      onRead?.(true);
      const proven = await proveSettlementAnchors(ctx.chain, snap, [...anchors.values()], signal ?? ctx.fence.signal)
        .finally(() => onRead?.(false));
      return retired.filter(i => i.proofBlock! > snap.finalized.number || !proven.has(i.proofBlock! + ":" + i.proofHash!.toLowerCase()));
    };
    const missing = await verify(result);
    if (missing.length) {
      result = await read([...needed, ...missing]);
      if (result.finalized.timestamp < cutoff) throw new WalletError("RPC_EVIDENCE_INVALID", "Finalized expiry evidence regressed.");
      const sampled = new Set(missing.map(i => i.nonce));
      if ((await verify(result)).some(i => !sampled.has(i.nonce)))
        throw new WalletError("RPC_EVIDENCE_INVALID", "Expiry evidence changed during allowance verification.");
    }
    for (const i of retired) checked.add(i.nonce);
  }
  checkedWaivers.set(result, checked);
  times.set(wallet.subjectId, result.finalized.timestamp);
  return result;
}

interface ModelObservation {
  snapshot: UptoChainSnapshot;
  walletId: string;
  generation: number;
  fresh(): boolean;
  anchor: { disputed: boolean; words: Map<string, bigint> };
}
// A verified ancestor remains an ancestor of this exact immutable snapshot.
const snapshotAnchors = new WeakMap<UptoChainSnapshot, ReadonlySet<string>>();
const modelObservations = new WeakMap<RuntimeContext, ModelObservation>();

const observationOf = new WeakMap<ChainSnapshot, ModelObservation>();
export function assertUndisputed(snapshot: ChainSnapshot) {
  requireWallet(!observationOf.get(snapshot)?.anchor.disputed, "RPC_EVIDENCE_INVALID", "The observed payment anchor was contradicted.");
}

/** Revalidate a frozen authorization synchronously, including after its intent has been reserved. */
export function commitEvidence(ctx: RuntimeContext, original: { snapshot: ChainSnapshot; proven: Set<string> },
  upto: UptoAuthorization | undefined, intents: readonly PaymentIntent[]) {
  const source = observationOf.get(original.snapshot);
  if (!source || !upto) return original;
  assertUndisputed(original.snapshot);
  const current = modelObservations.get(ctx);
  requireWallet(current && current.walletId === source.walletId && current.generation === source.generation && !current.anchor.disputed,
    "RPC_EVIDENCE_INVALID", "The observed wallet generation or anchor is unavailable.");
  const nonce = BigInt(upto.nonce), bits = current.anchor.words.get((nonce >> 8n).toString());
  requireWallet((bits === undefined || (bits & (1n << (nonce & 255n))) === 0n) && !current.snapshot.usedNonces.includes(upto.nonce),
    "RPC_EVIDENCE_INVALID", "The selected Permit2 nonce is already used.");
  if (current.anchor === source.anchor) return original;
  const snap = current.snapshot, used = new Set(snap.usedNonces);
  const proven = snapshotAnchors.get(snap) ?? new Set<string>();
  requireWallet(current.fresh() && upto.upto.permitNonce === null &&
    intents.every(i => i.walletId !== source.walletId || (
      (i.schedulingRelease?.kind !== "waived" || (checkedWaivers.get(snap)?.has(i.nonce) && !used.has(i.nonce))) &&
      (!needsSettlementCheck(i, snap.finalized.timestamp) || (used.has(i.nonce) && i.settlementBlock !== undefined &&
        i.settlementHash !== undefined && proven.has(i.settlementBlock + ":" + i.settlementHash.toLowerCase()))))),
    "RPC_EVIDENCE_INVALID", "The newer wallet observation cannot cover the frozen authorization.");
  return { snapshot: snap, proven };
}

/** One fresh read after inconsistent evidence, before the wallet creates any signing intent. */
async function readBeforeIntent<T>(signal: AbortSignal | undefined, read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      const result = await read();
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      if (attempt > 0 || !(error instanceof WalletError) || error.code !== "RPC_EVIDENCE_INVALID") throw error;
    }
  }
}

export async function modelObservation(ctx: RuntimeContext, wallet: WalletRecord, intents: readonly PaymentIntent[],
  amount: bigint, signal?: AbortSignal, force = false, onRead?: (active: boolean) => void, admissionHolds?: bigint, direct?: ModelDirectPayment, requireOwnRead = false) {
  const generation = ctx.fence.capture();
  const cached = (previous?: ModelObservation) => {
    if (!previous || previous.walletId !== wallet.walletId || previous.generation !== generation || !previous.fresh()) return;
    const snap = previous.snapshot;
    const used = new Set(snap.usedNonces);
    const coversReleases = intents.every(i => (i.schedulingRelease?.kind !== "waived" || expiredWaiverCovered(i, snap, used)) &&
      (!needsSettlementCheck(i, snap.finalized.timestamp) || (used.has(i.nonce) && i.settlementBlock !== undefined && i.settlementBlock <= snap.latest.number)));
    const available = uptoAvailability(intents, { ...snap, finalizedTimestamp: snap.finalized.timestamp }, direct, uptoValidAfter(snap.latest.timestamp));
    // A queued purchase may reuse negative evidence only to wait. A changed ledger is recomputed above.
    if (admissionHolds !== undefined && coversReleases && (available.permitPending ||
      ((available.inFlightAtomic > 0n || admissionHolds > 0n) && available.availableAtomic < amount))) {
      throw new AllowanceWait("The existing allowance is reserved by unsettled payments.",
        available.permitPending ? 0n : available.availableAtomic - admissionHolds);
    }
    if (coversReleases && !available.permitPending && available.availableAtomic >= amount &&
      BigInt(snap.balanceAtomic) >= amount + outstandingAtSnapshot(ctx.state.snapshot(), wallet.walletId, snap, snapshotAnchors.get(snap) ?? new Set())) {
      return { snapshot: snap, cached: true, fresh: previous.fresh };
    }
  };
  signal?.throwIfAborted();
  const warm = !force && !requireOwnRead && cached(modelObservations.get(ctx));
  if (warm) return warm;
  return readBeforeIntent(signal, async () => {
    const before = modelObservations.get(ctx);
    const age = ctx.clock.sampleFreshness();
    const snapshot = await paymentSnapshot(ctx, wallet, intents, signal, onRead).catch(error => {
      if (error instanceof WalletError && error.code === "RPC_EVIDENCE_INVALID" && before?.walletId === wallet.walletId &&
          before.generation === generation) before.anchor.disputed = true;
      throw error;
    });
    signal?.throwIfAborted();
    const current = modelObservations.get(ctx);
    let anchor: ModelObservation["anchor"] = { disputed: false, words: new Map() };
    if (current?.walletId === wallet.walletId && current.generation === generation) {
      const peer = current.snapshot;
      const heads = ["latest", "safe", "finalized"] as const;
      const sameLatest = snapshot.latest.number === peer.latest.number && snapshot.latest.hash === peer.latest.hash;
      const conflictingState = sameLatest && (snapshot.balanceAtomic !== peer.balanceAtomic ||
        snapshot.allowanceAtomic !== peer.allowanceAtomic || snapshot.permitNonce !== peer.permitNonce ||
        [...snapshot.nonceBitmaps ?? []].some(([word, bits]) => current.anchor.words.has(word) && current.anchor.words.get(word) !== bits));
      if (conflictingState || heads.some(head => snapshot[head].number === peer[head].number &&
          (snapshot[head].hash !== peer[head].hash || snapshot[head].timestamp !== peer[head].timestamp))) {
        current.anchor.disputed = true;
        throw new WalletError("RPC_EVIDENCE_INVALID", "Allowance observations contradict each other at the same block.");
      }
      if (heads.some(head => snapshot[head].number < peer[head].number)) {
        if (current !== before && heads.every(head => peer[head].number >= snapshot[head].number)) {
          const newer = !requireOwnRead && cached(current);
          if (newer) return newer;
        } else current.anchor.disputed = true;
        throw new WalletError("RPC_EVIDENCE_INVALID", "An older allowance observation arrived after newer evidence.");
      }
      if (sameLatest && !current.anchor.disputed) anchor = current.anchor;
    }
    ctx.clock.update(snapshot.latest.timestamp, ctx.state.snapshot().trustedTime);
    for (const [word, bits] of snapshot.nonceBitmaps ?? []) anchor.words.set(word, bits);
    const fresh = () => !anchor.disputed && modelObservations.get(ctx)?.anchor === anchor && age();
    const accepted = { snapshot, walletId: wallet.walletId, generation, fresh, anchor };
    observationOf.set(snapshot, accepted);
    modelObservations.set(ctx, accepted);
    return { snapshot, cached: false, fresh };
  });
}

export async function signingEvidence(ctx: RuntimeContext, scope: PaymentScope, wallet: WalletRecord, initial: WalletState, upto: boolean, cancel: AbortSignal, shared = false, force = false, direct?: ModelDirectPayment, modelRequest = false) {
  const intents = initial.intents.filter(item => item.subjectId === scope.subjectId);
  const observation = await paymentStage(scope.requestId, "final_chain", async () => {
    if (shared || modelRequest) return modelObservation(ctx, wallet, intents, BigInt(scope.amountAtomic),
      cancel, force, undefined, undefined, direct, !shared);
    const fresh = ctx.clock.sampleFreshness();
    const snapshot = upto ? await paymentSnapshot(ctx, wallet, intents, cancel) : await ctx.chain.snapshot(wallet.network, wallet.address, cancel);
    return { snapshot, cached: false, fresh };
  });
  const { snapshot } = observation;
  if (upto) await checkWaivedNonces(ctx, intents, (snapshot as UptoChainSnapshot).usedNonces);
  const known = shared ? snapshotAnchors.get(snapshot as UptoChainSnapshot) : undefined;
  const conservative = outstandingAtSnapshot(initial, wallet.walletId, snapshot, known ?? new Set());
  const needSpentAnchors = BigInt(snapshot.balanceAtomic) < conservative + BigInt(scope.amountAtomic);
  const anchors =
    [...new Map(initial.intents.filter(intent => intent.walletId === wallet.walletId && ((needSpentAnchors && intent.spent) || (upto && needsSettlementCheck(intent, snapshot.finalized.timestamp))) &&
      intent.settlementBlock !== undefined && intent.settlementHash !== undefined && intent.settlementBlock <= snapshot.latest.number)
      .map(intent => [`${intent.settlementBlock}:${intent.settlementHash!.toLowerCase()}`,
        { number: intent.settlementBlock!, hash: intent.settlementHash!.toLowerCase() }])).values()];
  const missing = anchors.filter(a => !known?.has(`${a.number}:${a.hash}`));
  const proven = new Set(known);
  const checked = await paymentStage(scope.requestId, "history_proof", () => proveSettlementAnchors(ctx.chain, snapshot, missing, cancel));
  for (const key of checked) proven.add(key);
  if (shared || modelRequest) snapshotAnchors.set(snapshot as UptoChainSnapshot, proven);
  return { ...observation, proven };
}
