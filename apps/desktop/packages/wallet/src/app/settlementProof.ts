import { requireWallet, WalletError } from "../domain/errors.js";
import type { WalletState } from "./state.js";
import type { ChainSnapshot, WalletChain } from "./ports.js";
import { abortable } from "./requestWait.js";

/** Proof work is per request, bounded by time, and never substitutes height for ancestry. */
export async function proveSettlementAnchors(chain: WalletChain, snapshot: ChainSnapshot,
  anchors: ReadonlyArray<{ number: number; hash: string }>, signal: AbortSignal,
  deadlineMs = 20000): Promise<Set<string>> {
  if (!anchors.length) return new Set();
  requireWallet(chain.canonicalSettlementAnchors, "SETTLEMENT_PROOF_INCOMPLETE",
    "The chain cannot verify historical settlement anchors.");
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), deadlineMs);
  timer.unref();
  const proofSignal = AbortSignal.any([signal, deadline.signal]);
  const proven = new Set<string>();
  try {
    for (let offset = 0; offset < anchors.length; offset += 64) {
      requireWallet(!proofSignal.aborted, "SETTLEMENT_PROOF_INCOMPLETE", "Settlement proof timed out or was canceled.");
      const batch = anchors.slice(offset, offset + 64);
      const requested = new Set(batch.map(anchor => `${anchor.number}:${anchor.hash.toLowerCase()}`));
      const verified = await abortable(chain.canonicalSettlementAnchors(snapshot, batch, proofSignal), proofSignal);
      requireWallet(!proofSignal.aborted, "SETTLEMENT_PROOF_INCOMPLETE", "Settlement proof timed out or was canceled.");
      for (const anchor of verified) {
        const key = `${anchor.number}:${anchor.hash.toLowerCase()}`;
        requireWallet(requested.has(key), "RPC_EVIDENCE_INVALID", "The chain returned an unrequested settlement anchor.");
        proven.add(key);
      }
    }
    return proven;
  } catch (error) {
    if (deadline.signal.aborted && !signal.aborted)
      throw new WalletError("SETTLEMENT_PROOF_INCOMPLETE", "Historical settlement proof exceeded its deadline.");
    throw error;
  } finally { clearTimeout(timer); }
}

export function outstandingAtSnapshot(state: WalletState, walletId: string, snapshot: ChainSnapshot,
  proven: ReadonlySet<string>): bigint {
  return state.intents.reduce((total, intent) => {
    if (intent.walletId !== walletId) return total;
    // Height alone cannot prove that a settlement on another branch is reflected
    // in this snapshot's balance. Without matching block evidence retain the risk.
    const settlementInSnapshot = intent.settlementBlock !== undefined && intent.settlementHash !== undefined &&
      ((snapshot.latest.number === intent.settlementBlock && snapshot.latest.hash === intent.settlementHash) ||
        proven.has(`${intent.settlementBlock}:${intent.settlementHash.toLowerCase()}`));
    return intent.reserved || (intent.spent && !settlementInSnapshot) ? total + BigInt(intent.amountAtomic) : total;
  }, 0n);
}

