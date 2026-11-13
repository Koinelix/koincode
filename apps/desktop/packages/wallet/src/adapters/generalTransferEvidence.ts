import { id } from "ethers";
import { atomic } from "../domain/atomic.js";
import { generalNetwork } from "../domain/generalNetworks.js";
import { assertGeneralSigningNetwork } from "../domain/generalSigningPolicy.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { digest } from "./canonical.js";
import type { GeneralTransferPreview } from "./generalTransferIntent.js";

const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const WORD = /^0x[0-9a-f]{64}$/;
const TRANSFER_TOPIC = id("Transfer(address,address,uint256)").toLowerCase();
const MAX_UINT = (1n << 256n) - 1n;

export type GeneralReceiptLog = { address: string; topics: string[]; data: string; removed: boolean };
export type GeneralReceiptObservation = {
  chainId: number; transactionHash: string; from: string; to: string; status: 0 | 1;
  blockNumber: string; blockHash: string; gasUsed: string; effectiveGasPrice: string; logs: GeneralReceiptLog[];
};
export type GeneralTransferEvidence =
  | { status: "UNKNOWN" | "REORGED" }
  | { status: "MINED" | "CONFIRMED" | "REVERTED"; confirmations: string; blockNumber: string; blockHash: string;
      executionFeeAtomic: string; effect: "native_receipt_success" | "matching_transfer_event" | "unverified" | "reverted" };

function invalid(): never { throw new WalletError("GENERAL_EVIDENCE_INVALID", "The transaction evidence is invalid."); }
function uint(value: unknown): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,77})$/.test(value)) return invalid();
  const result = BigInt(value);
  if (result > MAX_UINT) return invalid();
  return result;
}
function topicAddress(value: string): string | null {
  return /^0x0{24}[0-9a-f]{40}$/.test(value) ? `0x${value.slice(26)}` : null;
}

/**
 * Interprets already retrieved, chain-bound evidence. It performs no RPC, does not
 * close a risk, and a matching event is not proof against a malicious contract.
 * A caller must obtain the canonical block and head from a trusted chain adapter.
 */
export function evaluateGeneralTransferEvidence(input: {
  preview: GeneralTransferPreview; approvedDigest: string; transactionHash: string;
  receipt: GeneralReceiptObservation | null; canonicalBlockHash: string | null;
  headBlockNumber: string | null; requiredConfirmations: number;
}): GeneralTransferEvidence {
  try {
    const { preview } = input;
    requireWallet(preview && typeof preview === "object", "GENERAL_EVIDENCE_INVALID", "Invalid transaction identity.");
    const { digest: expected, ...fields } = preview;
    requireWallet(HASH.test(input.transactionHash) && /^[0-9a-f]{64}$/.test(input.approvedDigest) &&
      expected === input.approvedDigest && digest(fields) === expected && ADDRESS.test(preview.accountAddress) &&
      ADDRESS.test(preview.recipient) && Number.isSafeInteger(input.requiredConfirmations) &&
      input.requiredConfirmations >= 1 && input.requiredConfirmations <= 100000,
    "GENERAL_EVIDENCE_INVALID", "Invalid transaction identity.");
    const network = generalNetwork(preview.networkId);
    assertGeneralSigningNetwork(network.id, BigInt(preview.chainId));
    requireWallet(BigInt(preview.chainId) === BigInt(network.chainId) &&
      (preview.asset.kind === "native" || preview.asset.kind === "erc20" && ADDRESS.test(preview.asset.address)) &&
      atomic(preview.amountAtomic) > 0n && atomic(preview.amountAtomic) <= MAX_UINT,
    "GENERAL_EVIDENCE_INVALID", "Invalid transfer identity.");
    if (input.receipt === null) return { status: "UNKNOWN" };
    const receipt = input.receipt;
    requireWallet(receipt && receipt.chainId === network.chainId && receipt.transactionHash === input.transactionHash &&
      receipt.from === preview.accountAddress && receipt.to === (preview.asset.kind === "native" ? preview.recipient : preview.asset.address) &&
      (receipt.status === 0 || receipt.status === 1) && HASH.test(receipt.blockHash) && Array.isArray(receipt.logs) &&
      receipt.logs.length <= 4096, "GENERAL_EVIDENCE_INVALID", "Invalid receipt identity.");
    const block = uint(receipt.blockNumber), gasUsed = uint(receipt.gasUsed), gasPrice = uint(receipt.effectiveGasPrice);
    const fee = gasUsed * gasPrice;
    requireWallet(fee <= MAX_UINT, "GENERAL_EVIDENCE_INVALID", "Invalid receipt fee.");
    for (const log of receipt.logs) requireWallet(log && ADDRESS.test(log.address) && Array.isArray(log.topics) &&
      log.topics.length <= 4 && log.topics.every((topic) => typeof topic === "string" && WORD.test(topic)) &&
      typeof log.data === "string" && /^0x(?:[0-9a-f]{2}){0,4096}$/.test(log.data) && typeof log.removed === "boolean",
    "GENERAL_EVIDENCE_INVALID", "Invalid receipt log.");
    if (input.canonicalBlockHash === null || input.headBlockNumber === null) return { status: "UNKNOWN" };
    requireWallet(HASH.test(input.canonicalBlockHash), "GENERAL_EVIDENCE_INVALID", "Invalid canonical block.");
    if (input.canonicalBlockHash !== receipt.blockHash || receipt.logs.some((log) => log.removed)) return { status: "REORGED" };
    const head = uint(input.headBlockNumber);
    requireWallet(head >= block, "GENERAL_EVIDENCE_INVALID", "Invalid chain head.");
    const confirmations = head - block + 1n;
    let effect: "native_receipt_success" | "matching_transfer_event" | "unverified" | "reverted" = "reverted";
    if (receipt.status === 1) {
      if (preview.asset.kind === "native") effect = "native_receipt_success";
      else {
        const events = receipt.logs.filter((log) => log.address === (preview.asset.kind === "erc20" ? preview.asset.address : "") &&
          log.topics[0] === TRANSFER_TOPIC);
        const exact = events.filter((log) => log.topics.length === 3 && topicAddress(log.topics[1]!) === preview.accountAddress &&
          topicAddress(log.topics[2]!) === preview.recipient && WORD.test(log.data) && BigInt(log.data) === BigInt(preview.amountAtomic));
        // Extra token transfers can indicate non-standard effects; do not infer their outcome.
        effect = exact.length === 1 && events.length === 1 ? "matching_transfer_event" : "unverified";
      }
    }
    return { status: receipt.status === 0 ? "REVERTED" : confirmations >= BigInt(input.requiredConfirmations) ? "CONFIRMED" : "MINED",
      confirmations: confirmations.toString(), blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
      executionFeeAtomic: fee.toString(), effect };
  } catch (error) {
    if (error instanceof WalletError && error.code === "LEGACY_NETWORK_RESERVED") throw error;
    return invalid();
  }
}
