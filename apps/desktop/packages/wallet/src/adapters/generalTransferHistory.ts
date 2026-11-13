import { requireWallet } from "../domain/errors.js";
import { generalNetwork } from "../domain/generalNetworks.js";
import { GeneralSigningJournal } from "./generalSigningJournal.js";
import { GeneralTransferRecoveryReader } from "./generalTransferRecovery.js";

export type GeneralHistoryQuery = { sourceId: string; networkId: string; offset: number; limit: number; head?: string };
export type GeneralHistoryItem = {
  riskId: string; transferId: string; accountAddress: string; networkId: string;
  asset: "native" | `erc20:0x${string}`; decimals: number | null; recipient: string | null;
  amountAtomic: string; maxFeeAtomic: string; createdAt: null; riskRetained: true;
  phase: "SIGNING_POSSIBLE" | "SIGNED"; material: "available" | "unavailable" | "conflict";
  broadcast: "BROADCAST_POSSIBLE" | "SUBMITTED" | "UNKNOWN" | "no_record" | "unavailable"; transactionHash: string | null;
};
export type GeneralHistoryPage = { sourceId: string; accountAddress: string; networkId: string; status: "ready" | "unregistered";
  items: GeneralHistoryItem[]; head: string | null; nextOffset: number | null };

/** Display projection only. No intent, signature, protected reference or recovery capability crosses this boundary. */
export class GeneralTransferHistoryReader {
  constructor(private readonly journal: GeneralSigningJournal, private readonly recovery: GeneralTransferRecoveryReader) {}

  async read(input: GeneralHistoryQuery, accountAddress: string, current: () => void): Promise<GeneralHistoryPage> {
    requireWallet(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.sourceId) &&
      Number.isSafeInteger(input.offset) && input.offset >= 0 && input.offset <= 1000 &&
      Number.isSafeInteger(input.limit) && input.limit >= 1 && input.limit <= 20 &&
      (input.offset === 0 && input.head === undefined || typeof input.head === "string" && /^[0-9a-f]{64}$/.test(input.head)),
    "INVALID_REQUEST", "The transfer history page is invalid.");
    generalNetwork(input.networkId); current();
    const base = { sourceId: input.sourceId, accountAddress, networkId: input.networkId };
    const registered = await this.journal.hasRegisteredStream(accountAddress, input.networkId); current();
    if (!registered) {
      requireWallet(input.offset === 0 && input.head === undefined, "SIGNING_CONTINUITY_CONFLICT", "The signing stream is unavailable.");
      return { ...base, status: "unregistered", items: [], head: null, nextOffset: null };
    }
    const page = await this.recovery.read(accountAddress, input.networkId, input.offset, input.limit, input.head); current();
    return { ...base, status: "ready", head: page.head, nextOffset: page.nextOffset, items: page.items.map((item): GeneralHistoryItem => ({
      riskId: item.risk.riskId, transferId: item.risk.transferId, accountAddress: item.risk.accountAddress, networkId: item.risk.networkId,
      asset: item.risk.asset as GeneralHistoryItem["asset"], decimals: item.intent?.asset.decimals ?? (item.risk.asset === "native" ? 18 : null),
      recipient: item.intent?.recipient ?? null, amountAtomic: item.risk.amountAtomic, maxFeeAtomic: item.risk.maxGasAtomic,
      createdAt: null, riskRetained: true, phase: item.phase, material: item.material, broadcast: item.broadcast,
      transactionHash: item.material === "conflict" ? null : item.transactionHash ?? item.materialTransactionHash ?? null,
    })) };
  }
}
