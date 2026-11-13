import { requireWallet } from "../domain/errors.js";
import { GeneralGuardedState } from "./generalGuardedState.js";
import { GeneralSignedMaterialStore } from "./generalSignedMaterial.js";
import { GeneralSigningJournal } from "./generalSigningJournal.js";
import { GeneralTransferIntentStore } from "./generalTransferIntentStore.js";
import type { GeneralTransferPreview } from "./generalTransferIntent.js";
import type { GeneralPendingRisk } from "./generalSigningRiskMath.js";
import type { GeneralBroadcastStatus } from "./generalBroadcastRecord.js";

export type GeneralRecoveryItem = GeneralPendingRisk & {
  intent: GeneralTransferPreview | null;
  material: "available" | "unavailable" | "conflict";
  broadcast: GeneralBroadcastStatus | "no_record" | "unavailable";
  materialTransactionHash?: string;
};

/** Read-only recovery projection; it cannot sign, broadcast or release any risk. */
export class GeneralTransferRecoveryReader {
  constructor(private readonly owner: GeneralGuardedState, private readonly journal: GeneralSigningJournal,
    private readonly intents: GeneralTransferIntentStore, private readonly material: GeneralSignedMaterialStore,
    private readonly assertLifetime: () => void = () => {}) {}

  async read(accountAddress: string, networkId: string, offset: number, limit: number, expectedHead?: string): Promise<{
    items: GeneralRecoveryItem[]; nextOffset: number | null; head: string;
  }> {
    const { ownerId, installationId } = this.owner.snapshot();
    const current = () => { this.assertLifetime(); requireWallet(this.owner.isLive(ownerId, installationId), "SIGNING_CONTINUITY_UNKNOWN", "The recovery owner is unavailable."); };
    current();
    const page = await this.journal.listPendingRisks(accountAddress, networkId, offset, limit, expectedHead);
    current();
    const items: GeneralRecoveryItem[] = [];
    for (const item of page.items) {
      let intent: GeneralTransferPreview | null = null;
      let material: GeneralRecoveryItem["material"] = "unavailable", broadcast: GeneralRecoveryItem["broadcast"] = "unavailable";
      let materialTransactionHash: string | undefined;
      try { intent = await this.intents.readForRecovery(ownerId, item.risk); } catch { /* Preserve the risk even if its projection is missing. */ }
      current();
      if (intent) {
        try {
          const result = await this.material.recoverForJournal(intent, intent.digest, item.risk.riskId);
          materialTransactionHash = result.transactionHash;
          material = item.transactionHash && item.transactionHash !== result.transactionHash ? "conflict" : "available";
        } catch { /* Missing signed bytes do not imply that no signature exists. */ }
        current();
        const hash = item.transactionHash ?? materialTransactionHash;
        if (hash && material !== "conflict") {
          try { broadcast = await this.material.readBroadcast(intent, intent.digest, item.risk.riskId, hash) ?? "no_record"; }
          catch { /* A missing or invalid protected record is never treated as a successful broadcast. */ }
        }
      }
      current();
      items.push({ ...item, intent, material, broadcast, ...(materialTransactionHash ? { materialTransactionHash } : {}) });
    }
    await this.journal.listPendingRisks(accountAddress, networkId, offset, limit, page.head);
    current();
    return { items, nextOffset: page.nextOffset, head: page.head };
  }
}
