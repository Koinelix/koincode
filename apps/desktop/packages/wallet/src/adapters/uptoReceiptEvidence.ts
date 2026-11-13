import { Interface, verifyTypedData } from "ethers";
import { decodeAbiParameters, encodeFunctionData, keccak256, parseAbi, toBytes } from "viem";
import type { PaymentIntent } from "../domain/model.js";
import { PERMIT2_ADDRESS, UPTO_PROXY_ADDRESS, uptoTypedData, usdcPermitTypedData, type UptoAuthorization } from "../domain/uptoAuthorization.js";
import { requireWallet } from "../domain/errors.js";
import { chainBlock, chainHeight } from "./chainValues.js";
import { receiptLog, topicAddress, TRANSFER_TOPIC, type ReceiptEvidence } from "./receiptEvidence.js";

const proxy = new Interface([
  "function settle(((address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permit,uint256 amount,address owner,(address to,address facilitator,uint256 validAfter) witness,bytes signature)",
  "function settleWithPermit((uint256 value,uint256 deadline,bytes32 r,bytes32 s,uint8 v) permit2612,((address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) permit,uint256 amount,address owner,(address to,address facilitator,uint256 validAfter) witness,bytes signature)",
]);
const attribution = "a161776a6364705f666163696c31000e0280218021802180218021802180218021";
const same = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const hash = (value: unknown): string => {
  requireWallet(typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value), "RPC_EVIDENCE_INVALID", "The chain hash is invalid.");
  return value.toLowerCase();
};
const object = (value: unknown): Record<string, unknown> => {
  requireWallet(value && typeof value === "object" && !Array.isArray(value), "RPC_EVIDENCE_INVALID", "The chain evidence is missing.");
  return value as Record<string, unknown>;
};

/** A matching small Transfer is insufficient: bind canonical calldata, signatures, proxy and nonce use. */
export async function verifyUptoReceipt(rpc: { call(method: string, params: unknown[]): Promise<unknown> },
  intent: PaymentIntent, payer: string, txHash: string): Promise<(ReceiptEvidence & { actualAmountAtomic: string }) | null> {
  requireWallet(intent.upto, "RPC_EVIDENCE_INVALID", "The upto signing intent is missing.");
  const rawReceipt = await rpc.call("eth_getTransactionReceipt", [hash(txHash)]);
  if (rawReceipt === null) return null;
  const receipt = object(rawReceipt), transaction = object(await rpc.call("eth_getTransactionByHash", [txHash]));
  requireWallet(receipt.status === "0x1" && same(receipt.transactionHash, txHash) &&
    same(transaction.hash, txHash) && same(transaction.to, UPTO_PROXY_ADDRESS) && same(transaction.from, intent.upto.facilitator) &&
    same(transaction.blockHash, hash(receipt.blockHash)) && transaction.blockNumber === receipt.blockNumber &&
    Array.isArray(receipt.logs) && receipt.logs.length <= 2000 && typeof transaction.input === "string" && /^0x[0-9a-f]+$/i.test(transaction.input),
    "RPC_EVIDENCE_INVALID", "The direct facilitator settlement does not match the original payment.");
  const decoded = proxy.parseTransaction({ data: transaction.input });
  requireWallet(decoded && (decoded.name === "settle" || decoded.name === "settleWithPermit"), "RPC_EVIDENCE_INVALID", "The proxy method is unsupported.");
  const canonical = proxy.encodeFunctionData(decoded.fragment, decoded.args).toLowerCase();
  requireWallet(transaction.input.toLowerCase() === canonical || transaction.input.toLowerCase() === canonical + attribution,
    "RPC_EVIDENCE_INVALID", "The settlement calldata is not canonical.");
  const args = decoded.args;
  const permit = args.permit, witness = args.witness, actual = args.amount as bigint;
  requireWallet(same(args.owner, payer) && same(permit.permitted.token, intent.asset) &&
    permit.permitted.amount === BigInt(intent.amountAtomic) && permit.nonce === BigInt(intent.nonce) &&
    permit.deadline === BigInt(intent.validBefore) && same(witness.to, intent.payTo) &&
    same(witness.facilitator, intent.upto.facilitator) && witness.validAfter === BigInt(intent.validAfter) &&
    actual > 0n && actual <= BigInt(intent.amountAtomic), "RPC_EVIDENCE_INVALID", "The proxy arguments differ from the signed authorization.");
  const authorization: UptoAuthorization = { network: intent.network, asset: intent.asset, payer, payTo: intent.payTo,
    amountAtomic: intent.amountAtomic, nonce: intent.nonce, validAfter: intent.validAfter, validBefore: intent.validBefore, upto: intent.upto };
  const typed = uptoTypedData(authorization);
  requireWallet(same(verifyTypedData(typed.domain, typed.types, typed.message, args.signature), payer),
    "RPC_EVIDENCE_INVALID", "The Permit2 signature does not authorize this payment.");
  if (decoded.name === "settleWithPermit") {
    const approval = args.permit2612, permitTyped = usdcPermitTypedData(authorization);
    requireWallet(approval.value === BigInt(intent.amountAtomic) && approval.deadline === BigInt(intent.validBefore) &&
      (approval.v === 27n || approval.v === 28n) && same(verifyTypedData(permitTyped.domain, permitTyped.types, permitTyped.message,
        { r: approval.r, s: approval.s, v: Number(approval.v) }), payer),
      "RPC_EVIDENCE_INVALID", "The USDC permit differs from the original authorization.");
  }
  const block = chainBlock(await rpc.call("eth_getBlockByNumber", [receipt.blockNumber, false]));
  requireWallet(block.number === chainHeight(receipt.blockNumber) && block.number >= intent.anchorBlock &&
    block.hash === hash(receipt.blockHash) && block.timestamp >= intent.validAfter && block.timestamp <= intent.validBefore,
    "RPC_EVIDENCE_INVALID", "The settlement block differs from the authorization window or canonical chain.");
  const logs = (receipt.logs as unknown[]).map(receiptLog);
  requireWallet(new Set(logs.map(log => log.logIndex)).size === logs.length && logs.every(log =>
    log.blockHash === block.hash && log.blockNumber === block.number && same(log.transactionHash, txHash)),
    "RPC_EVIDENCE_INVALID", "The settlement logs have inconsistent identities.");
  const transfers = logs.filter(log => log.address === intent.asset && log.topics.length === 3 &&
    log.topics[0] === TRANSFER_TOPIC && log.topics[1] === topicAddress(payer) && log.topics[2] === topicAddress(intent.payTo) &&
    /^0x[0-9a-f]{64}$/.test(log.data) && BigInt(log.data) === actual);
  const event = keccak256(toBytes(decoded.name === "settle" ? "Settled()" : "SettledWithPermit()"));
  const settlements = logs.filter(log => log.address === UPTO_PROXY_ADDRESS && log.topics.length === 1 && log.topics[0] === event && log.data === "0x");
  requireWallet(transfers.length === 1 && settlements.length === 1 && transfers[0]!.logIndex < settlements[0]!.logIndex,
    "RPC_EVIDENCE_INVALID", "The receipt does not prove one matching settlement transfer.");
  const nonce = BigInt(intent.nonce);
  const bitmap = await rpc.call("eth_call", [{ to: PERMIT2_ADDRESS, data: encodeFunctionData({
    abi: parseAbi(["function nonceBitmap(address owner,uint256 wordPos) view returns(uint256)"]), functionName: "nonceBitmap",
    args: [payer as `0x${string}`, nonce >> 8n],
  }) }, "0x" + block.number.toString(16)]);
  requireWallet(typeof bitmap === "string" && /^0x[0-9a-f]{64}$/i.test(bitmap) &&
    (decodeAbiParameters([{ type: "uint256" }], bitmap as `0x${string}`)[0] & (1n << (nonce & 255n))) !== 0n,
    "RPC_EVIDENCE_INVALID", "The original Permit2 nonce has not been consumed.");
  return { network: intent.network, txHash: txHash.toLowerCase(), logIndex: transfers[0]!.logIndex,
    block, evidenceKey: [intent.network, txHash.toLowerCase(), transfers[0]!.logIndex].join(":"), actualAmountAtomic: actual.toString() };
}
