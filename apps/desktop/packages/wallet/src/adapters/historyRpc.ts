import type { HistoryPageInput, HistoryPageResult, VerifiedOutflow } from "../app/ports.js";
import { requireWallet } from "../domain/errors.js";
import { networkConfig } from "../domain/networks.js";
import { chainBlock, chainHeight } from "./chainValues.js";
import { receiptLog, topicAddress, TRANSFER_TOPIC } from "./receiptEvidence.js";
import { digest } from "./canonical.js";
interface RpcReader {
  call(method: string, params: unknown[]): Promise<unknown>;
}
const quantity = (number: number) => "0x" + number.toString(16);
export async function verifyHistoryPage(
  rpc: RpcReader,
  input: HistoryPageInput,
): Promise<HistoryPageResult> {
  requireWallet(
    input.asset.toLowerCase() === networkConfig(input.network).asset &&
      /^0x[0-9a-f]{40}$/i.test(input.payer) &&
      [
        input.baselineBlock,
        input.checkpointBlock,
        input.targetBlock,
        input.fromBlock,
        input.toBlock,
      ].every((number) => Number.isSafeInteger(number) && number >= 0) &&
      [input.baselineHash, input.checkpointHash, input.targetHash].every((hash) =>
        /^0x[0-9a-f]{64}$/.test(hash),
      ) &&
      input.fromBlock >= input.baselineBlock &&
      input.toBlock >= input.fromBlock &&
      input.toBlock - input.fromBlock < 200 &&
      input.toBlock <= input.targetBlock &&
      (input.fromBlock === input.baselineBlock
        ? input.checkpointBlock === input.baselineBlock
        : input.checkpointBlock + 1 === input.fromBlock),
    "RECOVERY_RANGE_INVALID",
    "A continuous bounded recovery page is required.",
  );
  requireWallet(
    chainHeight(await rpc.call("eth_chainId", [])) === networkConfig(input.network).chainId,
    "RPC_CHAIN_MISMATCH",
    "Recovery RPC returned another chain.",
  );
  const at = async (number: number) => {
    const block = chainBlock(await rpc.call("eth_getBlockByNumber", [quantity(number), false]));
    requireWallet(
      block.number === number,
      "RPC_EVIDENCE_INVALID",
      "The recovery block height changed.",
    );
    return block;
  };
  const assertAnchors = async () => {
    for (const [number, hash] of [
      [input.baselineBlock, input.baselineHash],
      [input.checkpointBlock, input.checkpointHash],
      [input.targetBlock, input.targetHash],
    ] as const)
      requireWallet(
        (await at(number)).hash === hash,
        "RECOVERY_ANCHOR_CHANGED",
        "A recovery baseline, checkpoint or target is noncanonical.",
      );
    const safe = chainBlock(await rpc.call("eth_getBlockByNumber", ["safe", false]));
    requireWallet(
      safe.number >= input.targetBlock && (await at(safe.number)).hash === safe.hash,
      "RPC_EVIDENCE_INVALID",
      "The recovery target is not covered by a canonical safe head.",
    );
  };
  await assertAnchors();
  const value = await rpc.call("eth_getLogs", [
    {
      address: input.asset,
      topics: [TRANSFER_TOPIC, topicAddress(input.payer)],
      fromBlock: quantity(input.fromBlock),
      toBlock: quantity(input.toBlock),
    },
  ]);
  requireWallet(
    Array.isArray(value) && value.length <= 512,
    "RECOVERY_PAGE_TOO_LARGE",
    "The recovery page exceeds its bounded event limit.",
  );
  const logs = value
      .map(receiptLog)
      .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex),
    seen = new Set<string>();
  for (const log of logs) {
    const key = log.blockHash + ":" + log.logIndex;
    requireWallet(
      !seen.has(key) &&
        log.address === input.asset.toLowerCase() &&
        log.topics.length === 3 &&
        log.topics[0] === TRANSFER_TOPIC &&
        log.topics[1] === topicAddress(input.payer) &&
        /^0x0{24}[0-9a-f]{40}$/.test(log.topics[2]!) &&
        /^0x[0-9a-f]{64}$/.test(log.data) &&
        log.blockNumber >= input.fromBlock &&
        log.blockNumber <= input.toBlock,
      "RPC_EVIDENCE_INVALID",
      "The complete outgoing log range is invalid or contradictory.",
    );
    seen.add(key);
  }
  const logsDigest = digest(logs),
    startIndex = input.cursor?.nextIndex ?? 0;
  requireWallet(
    Number.isSafeInteger(startIndex) &&
      startIndex >= 0 &&
      startIndex <= logs.length &&
      (!input.cursor ||
        (input.cursor.logsDigest === logsDigest && input.cursor.outflows.length === startIndex)),
    "RECOVERY_PAGE_CHANGED",
    "The complete page differs from its protected verification cursor.",
  );
  const outflows: VerifiedOutflow[] = structuredClone(input.cursor?.outflows ?? []);
  for (let index = 0; index < startIndex; index++) {
    const flow = outflows[index]!,
      log = logs[index]!;
    requireWallet(
      flow.evidenceKey === [input.network, log.transactionHash, log.logIndex].join(":") &&
        flow.amountAtomic === BigInt(log.data).toString() &&
        flow.txHash === log.transactionHash &&
        flow.logIndex === log.logIndex &&
        flow.block.hash === log.blockHash &&
        flow.block.number === log.blockNumber &&
        Number.isSafeInteger(flow.settledAt) &&
        flow.settledAt >= 0 &&
        flow.settledAt === flow.block.timestamp,
      "RECOVERY_PAGE_CHANGED",
      "A protected receipt prefix differs from the current complete log range.",
    );
  }
  const nextIndex = Math.min(logs.length, startIndex + 32);
  seen.clear();
  const receipts = new Map<string, Record<string, unknown>>();
  let receiptBytes = 0;
  for (const log of logs.slice(startIndex, nextIndex)) {
    const evidenceKey = [input.network, log.transactionHash, log.logIndex].join(":");
    requireWallet(
      !seen.has(evidenceKey) &&
        log.address === input.asset.toLowerCase() &&
        log.topics.length === 3 &&
        log.topics[0] === TRANSFER_TOPIC &&
        log.topics[1] === topicAddress(input.payer) &&
        /^0x0{24}[0-9a-f]{40}$/.test(log.topics[2]!) &&
        /^0x[0-9a-f]{64}$/.test(log.data) &&
        log.blockNumber >= input.fromBlock &&
        log.blockNumber <= input.toBlock,
      "RPC_EVIDENCE_INVALID",
      "An outgoing transfer does not match its complete recovery range.",
    );
    seen.add(evidenceKey);
    let receipt = receipts.get(log.transactionHash);
    if (!receipt) {
      const value = await rpc.call("eth_getTransactionReceipt", [log.transactionHash]);
      requireWallet(
        value && typeof value === "object" && !Array.isArray(value),
        "RPC_EVIDENCE_INVALID",
        "An outgoing transfer receipt is missing.",
      );
      receipt = value as Record<string, unknown>;
      receiptBytes += Buffer.byteLength(JSON.stringify(receipt));
      requireWallet(
        receiptBytes <= 16 * 1024 * 1024,
        "RECOVERY_PAGE_TOO_LARGE",
        "Recovery receipt memory exceeds its bounded page limit.",
      );
      receipts.set(log.transactionHash, receipt);
    }
    requireWallet(
      receipt.status === "0x1" &&
        typeof receipt.transactionHash === "string" &&
        receipt.transactionHash.toLowerCase() === log.transactionHash &&
        typeof receipt.blockHash === "string" &&
        receipt.blockHash.toLowerCase() === log.blockHash &&
        chainHeight(receipt.blockNumber) === log.blockNumber &&
        Array.isArray(receipt.logs) &&
        receipt.logs.length <= 2000,
      "RPC_EVIDENCE_INVALID",
      "An outgoing transfer receipt is unsuccessful or inconsistent.",
    );
    const receiptLogs = receipt.logs.map(receiptLog);
    requireWallet(
      new Set(receiptLogs.map((item) => item.logIndex)).size === receiptLogs.length &&
        receiptLogs.every(
          (item) =>
            item.transactionHash === log.transactionHash &&
            item.blockHash === log.blockHash &&
            item.blockNumber === log.blockNumber,
        ),
      "RPC_EVIDENCE_INVALID",
      "Recovery receipt log identities are inconsistent.",
    );
    const matches = receiptLogs.filter((item) => item.logIndex === log.logIndex);
    requireWallet(
      matches.length === 1 && JSON.stringify(matches[0]) === JSON.stringify(log),
      "RPC_EVIDENCE_INVALID",
      "The outgoing transfer is absent from its matching receipt.",
    );
    const block = await at(log.blockNumber);
    requireWallet(
      block.hash === log.blockHash,
      "RPC_EVIDENCE_INVALID",
      "An outgoing transfer is not canonical.",
    );
    outflows.push({
      evidenceKey,
      amountAtomic: BigInt(log.data).toString(),
      settledAt: block.timestamp,
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      block,
    });
  }
  const end = await at(input.toBlock);
  await assertAnchors();
  requireWallet(
    (await at(input.toBlock)).hash === end.hash,
    "RECOVERY_ANCHOR_CHANGED",
    "The recovery page changed during verification.",
  );
  return {
    fromBlock: input.fromBlock,
    toBlock: input.toBlock,
    endHash: end.hash,
    outflows,
    logsDigest,
    nextIndex,
    complete: nextIndex === logs.length,
  };
}
