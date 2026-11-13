import { keccak256, toBytes } from "viem";
import type { Network, PaymentIntent } from "../domain/model.js";
import type { ChainBlock } from "../app/ports.js";
import { requireWallet } from "../domain/errors.js";
import { chainBlock, chainHeight } from "./chainValues.js";
interface RpcReader {
  call(method: string, params: unknown[]): Promise<unknown>;
}
export const USED_TOPIC = keccak256(toBytes("AuthorizationUsed(address,bytes32)"));
export const CANCELED_TOPIC = keccak256(toBytes("AuthorizationCanceled(address,bytes32)"));
export const TRANSFER_TOPIC = keccak256(toBytes("Transfer(address,address,uint256)"));
export const topicAddress = (address: string) =>
  "0x" + address.slice(2).toLowerCase().padStart(64, "0");
export interface ReceiptLog {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  blockHash: string;
  blockNumber: number;
  logIndex: number;
}
export interface ReceiptEvidence {
  network: Network;
  txHash: string;
  logIndex: number;
  block: ChainBlock;
  evidenceKey: string;
}
function object(value: unknown): Record<string, unknown> {
  requireWallet(
    value && typeof value === "object" && !Array.isArray(value),
    "RPC_EVIDENCE_INVALID",
    "Receipt evidence is missing.",
  );
  return value as Record<string, unknown>;
}
function hash(value: unknown): string {
  requireWallet(
    typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value),
    "RPC_EVIDENCE_INVALID",
    "A receipt hash is invalid.",
  );
  return value.toLowerCase();
}
export function receiptLog(value: unknown): ReceiptLog {
  const log = object(value);
  requireWallet(
    typeof log.address === "string" &&
      /^0x[0-9a-f]{40}$/i.test(log.address) &&
      Array.isArray(log.topics) &&
      log.topics.length <= 4 &&
      typeof log.data === "string" &&
      /^0x([0-9a-f]{2})*$/i.test(log.data) &&
      log.data.length <= 16386 &&
      (log.removed === undefined || log.removed === false),
    "RPC_EVIDENCE_INVALID",
    "A receipt log is invalid or removed.",
  );
  return {
    address: log.address.toLowerCase(),
    topics: log.topics.map(hash),
    data: log.data.toLowerCase(),
    transactionHash: hash(log.transactionHash),
    blockHash: hash(log.blockHash),
    blockNumber: chainHeight(log.blockNumber),
    logIndex: chainHeight(log.logIndex),
  };
}
export function matchUsedReceipt(
  value: unknown,
  intent: PaymentIntent,
  payer: string,
  txHash: string,
): { blockNumber: number; blockHash: string; logIndex: number } {
  const receipt = object(value);
  requireWallet(
    receipt.status === "0x1" &&
      hash(receipt.transactionHash) === txHash.toLowerCase() &&
      Array.isArray(receipt.logs) &&
      receipt.logs.length <= 2000,
    "RPC_EVIDENCE_INVALID",
    "A successful matching receipt is required.",
  );
  const blockNumber = chainHeight(receipt.blockNumber),
    blockHash = hash(receipt.blockHash);
  requireWallet(
    blockNumber >= intent.anchorBlock,
    "RPC_EVIDENCE_INVALID",
    "Settlement precedes the authorization anchor.",
  );
  const logs = receipt.logs.map(receiptLog).sort((a, b) => a.logIndex - b.logIndex);
  requireWallet(
    new Set(logs.map((log) => log.logIndex)).size === logs.length &&
      logs.every(
        (log) =>
          log.blockNumber === blockNumber &&
          log.blockHash === blockHash &&
          log.transactionHash === txHash.toLowerCase(),
      ),
    "RPC_EVIDENCE_INVALID",
    "Receipt log identities are inconsistent.",
  );
  const identity = (log: ReceiptLog, topic: string) =>
    log.address === intent.asset.toLowerCase() &&
    log.topics.length === 3 &&
    log.topics[0] === topic &&
    log.topics[1] === topicAddress(payer) &&
    log.topics[2] === intent.nonce.toLowerCase() &&
    log.data === "0x";
  const used = logs.filter((log) => identity(log, USED_TOPIC));
  requireWallet(
    used.length === 1 && !logs.some((log) => identity(log, CANCELED_TOPIC)),
    "RPC_EVIDENCE_INVALID",
    "The receipt does not prove one unambiguous authorization use.",
  );
  const transfer = logs.find((log) => log.logIndex === used[0]!.logIndex + 1);
  requireWallet(
    transfer &&
      transfer.address === intent.asset.toLowerCase() &&
      transfer.topics.length === 3 &&
      transfer.topics[0] === TRANSFER_TOPIC &&
      transfer.topics[1] === topicAddress(payer) &&
      transfer.topics[2] === topicAddress(intent.payTo) &&
      /^0x[0-9a-f]{64}$/.test(transfer.data) &&
      BigInt(transfer.data) === BigInt(intent.amountAtomic),
    "RPC_EVIDENCE_INVALID",
    "The adjacent token transfer differs from the authorization.",
  );
  return { blockNumber, blockHash, logIndex: used[0]!.logIndex };
}
export async function verifyUsedReceipt(
  rpc: RpcReader,
  intent: PaymentIntent,
  payer: string,
  txHash: string,
): Promise<ReceiptEvidence | null> {
  hash(txHash);
  const receipt = await rpc.call("eth_getTransactionReceipt", [txHash]);
  if (receipt === null) return null;
  const match = matchUsedReceipt(receipt, intent, payer, txHash);
  const block = chainBlock(
    await rpc.call("eth_getBlockByNumber", ["0x" + match.blockNumber.toString(16), false]),
  );
  requireWallet(
    block.number === match.blockNumber &&
      block.hash === match.blockHash &&
      block.timestamp > intent.validAfter &&
      block.timestamp < intent.validBefore,
    "RPC_EVIDENCE_INVALID",
    "The settlement block is noncanonical or outside the authorization window.",
  );
  return {
    network: intent.network,
    txHash: txHash.toLowerCase(),
    logIndex: match.logIndex,
    block,
    evidenceKey: [intent.network, txHash.toLowerCase(), match.logIndex].join(":"),
  };
}
