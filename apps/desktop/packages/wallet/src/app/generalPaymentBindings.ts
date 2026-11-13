import { synchronizeDesktopClientScope } from "./desktopClient.js";
import { networkConfig } from "../domain/networks.js";
import { randomUUID } from "node:crypto";
import type { GeneralManagedKey } from "./ports.js";
import type { WalletRecord, WalletState } from "./state.js";
import { requireWallet } from "../domain/errors.js";

/** Pure state transition for the fixed payment owner. Inputs are not admission
 * evidence: its native source inspection and original guarded mutation must
 * remain live around this call. No UI, SDK or Skill entry exposes this helper. */
export function attachGeneralPaymentSource(state: WalletState, key: GeneralManagedKey,
  baseline: { blockNumber: number; blockHash: string }): WalletRecord {
  const source = structuredClone(key.source);
  const sameSource = state.wallets.find((entry) => entry.kind === "general_source" &&
    entry.source.installationId === source.installationId && entry.source.enrollmentId === source.enrollmentId &&
    entry.source.profileId === source.profileId && entry.source.sourceId === source.sourceId);
  if (sameSource) {
    requireWallet(sameSource.kind === "general_source" && sameSource.source.sourceCommitment === source.sourceCommitment &&
      sameSource.network === key.network && sameSource.address === key.address,
      "GENERAL_SOURCE_BINDING_CONFLICT", "The original source identity cannot be rebound.");
    return sameSource;
  }
  const existing = state.wallets.find((entry) => entry.address.toLowerCase() === key.address.toLowerCase());
  if (existing) {
    requireWallet(existing.network === key.network && existing.asset === networkConfig(key.network).asset,
      "NETWORK_KEY_REUSE", "The existing chain identity cannot be reused with another network or asset.");
    return existing;
  }
  const subjectId = randomUUID();
  const wallet: WalletRecord = { kind: "general_source", walletId: randomUUID(), subjectId, network: key.network,
    address: key.address, asset: networkConfig(key.network).asset, source,
    baselineBlock: baseline.blockNumber, baselineHash: baseline.blockHash };
  state.wallets.push(wallet);
  state.subjects.push({ subjectId, ownerId: state.ownerId, address: wallet.address, network: wallet.network, asset: wallet.asset,
    recoveryRequired: false, signingPaused: false });
  state.policies[subjectId] = { enabled: false, maxPerPaymentAtomic: "0", maxRolling24hAtomic: "0", maxCumulativeAtomic: "0", version: 1 };
  synchronizeDesktopClientScope(state);
  return wallet;
}
