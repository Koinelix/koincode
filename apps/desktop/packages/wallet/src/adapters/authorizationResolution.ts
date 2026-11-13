import { encodeFunctionData, parseAbi, decodeAbiParameters } from "viem";
import type { PaymentIntent } from "../domain/model.js";
import type { AuthorizationResolution, ChainBlock } from "../app/ports.js";
import { chainBlock } from "./chainValues.js";
import { CANCELED_TOPIC, USED_TOPIC, topicAddress, receiptLog } from "./receiptEvidence.js";
import { requireWallet } from "../domain/errors.js";
interface Reader {
  call(method: string, params: unknown[]): Promise<unknown>;
}
const abi = parseAbi(["function authorizationState(address,bytes32) view returns(bool)"]);
const height = (n: number) => "0x" + n.toString(16);
async function block(rpc: Reader, n: number | string): Promise<ChainBlock> {
  const result = chainBlock(
    await rpc.call("eth_getBlockByNumber", [typeof n === "string" ? n : height(n), false]),
  );
  requireWallet(
    typeof n !== "number" || result.number === n,
    "RPC_EVIDENCE_INVALID",
    "The returned proof block height differs.",
  );
  return result;
}
export async function resolveAuthorization(
  rpc: Reader,
  intent: PaymentIntent,
  payer: string,
): Promise<AuthorizationResolution> {
  const latest = await block(rpc, "latest"),
    safe = await block(rpc, "safe");
  requireWallet(
    safe.number <= latest.number && safe.timestamp <= latest.timestamp,
    "RPC_EVIDENCE_INVALID",
    "Confirmation heads disagree.",
  );
  requireWallet(
    safe.number !== latest.number ||
      (safe.hash === latest.hash && safe.timestamp === latest.timestamp),
    "RPC_EVIDENCE_INVALID",
    "Same-height confirmation heads conflict.",
  );
  requireWallet(
    (await block(rpc, latest.number)).hash === latest.hash &&
      (await block(rpc, safe.number)).hash === safe.hash,
    "RPC_EVIDENCE_INVALID",
    "Confirmation anchors changed.",
  );
  if (intent.proofBlock !== undefined && intent.proofHash) {
    const proof = await block(rpc, intent.proofBlock);
    if (proof.hash !== intent.proofHash)
      return { kind: "proof_reorg", trustedTime: latest.timestamp };
  }
  if (safe.number < intent.anchorBlock) return { kind: "pending", trustedTime: latest.timestamp };
  const previous = intent.resolution;
  const target = previous ? await block(rpc, previous.target.number) : safe;
  requireWallet(
    !previous || target.hash === previous.target.hash,
    "RPC_EVIDENCE_INVALID",
    "The resolution target changed during scanning.",
  );
  requireWallet(
    target.number <= safe.number,
    "RPC_EVIDENCE_INVALID",
    "The resolution target is not safe.",
  );
  const anchor = await block(rpc, intent.anchorBlock);
  requireWallet(
    anchor.hash === intent.anchorHash,
    "RPC_EVIDENCE_INVALID",
    "The signing anchor was reorganized; complete historical recovery is required.",
  );
  let next = previous?.nextBlock ?? intent.anchorBlock;
  let cancellation = previous?.cancellation;
  let usedTxHash = previous?.usedTxHash;
  for (let page = 0; page < 8 && next <= target.number; page++) {
    const end = Math.min(next + 199, target.number);
    const raw = await rpc.call("eth_getLogs", [
      {
        address: intent.asset,
        fromBlock: height(next),
        toBlock: height(end),
        topics: [[USED_TOPIC, CANCELED_TOPIC], topicAddress(payer), intent.nonce],
      },
    ]);
    requireWallet(
      Array.isArray(raw) && raw.length <= 2,
      "RPC_EVIDENCE_INVALID",
      "Nonce logs are contradictory or unbounded.",
    );
    for (const value of raw) {
      const log = receiptLog(value);
      requireWallet(
        log.address === intent.asset.toLowerCase() &&
          log.topics.length === 3 &&
          log.topics[1] === topicAddress(payer) &&
          log.topics[2] === intent.nonce.toLowerCase() &&
          log.blockNumber >= next &&
          log.blockNumber <= end &&
          log.data === "0x",
        "RPC_EVIDENCE_INVALID",
        "Nonce log identity differs from the requested range.",
      );
      if (log.topics[0] === USED_TOPIC) {
        requireWallet(
          !cancellation,
          "RPC_EVIDENCE_INVALID",
          "Used and canceled evidence conflict.",
        );
        requireWallet(
          !usedTxHash,
          "RPC_EVIDENCE_INVALID",
          "Multiple nonce use events contradict each other.",
        );
        usedTxHash = log.transactionHash;
        continue;
      }
      requireWallet(
        log.topics[0] === CANCELED_TOPIC && !cancellation && !usedTxHash,
        "RPC_EVIDENCE_INVALID",
        "Cancellation evidence is contradictory.",
      );
      const receipt = (await rpc.call("eth_getTransactionReceipt", [log.transactionHash])) as {
        status?: string;
        transactionHash?: string;
        blockHash?: string;
        logs?: unknown[];
      };
      requireWallet(
        receipt?.status === "0x1" &&
          receipt.transactionHash?.toLowerCase() === log.transactionHash &&
          receipt.blockHash?.toLowerCase() === log.blockHash &&
          Array.isArray(receipt.logs) &&
          receipt.logs.length <= 2000,
        "RPC_EVIDENCE_INVALID",
        "Cancellation requires a successful matching receipt.",
      );
      const logs = receipt.logs.map(receiptLog),
        canonical = await block(rpc, log.blockNumber);
      requireWallet(
        canonical.hash === log.blockHash &&
          logs.filter(
            (x) =>
              x.address === log.address &&
              x.topics[1] === topicAddress(payer) &&
              x.topics[2] === intent.nonce.toLowerCase(),
          ).length === 1 &&
          logs.every(
            (x) =>
              x.transactionHash === log.transactionHash &&
              x.blockHash === log.blockHash &&
              x.blockNumber === log.blockNumber,
          ) &&
          logs.some(
            (x) =>
              x.logIndex === log.logIndex &&
              x.address === log.address &&
              x.topics[0] === CANCELED_TOPIC &&
              x.topics[1] === topicAddress(payer) &&
              x.topics[2] === intent.nonce.toLowerCase() &&
              x.data === "0x",
          ),
        "RPC_EVIDENCE_INVALID",
        "Cancellation receipt or canonical block conflicts.",
      );
      cancellation = { txHash: log.transactionHash, block: canonical, logIndex: log.logIndex };
    }
    next = end + 1;
  }
  const checkTarget = await block(rpc, target.number),
    checkAnchor = await block(rpc, intent.anchorBlock);
  requireWallet(
    checkTarget.hash === target.hash && checkAnchor.hash === anchor.hash,
    "RPC_EVIDENCE_INVALID",
    "Resolution anchors changed during verification.",
  );
  if (next <= target.number)
    return {
      kind: "progress",
      trustedTime: latest.timestamp,
      cursor: {
        nextBlock: next,
        target,
        ...(cancellation ? { cancellation } : {}),
        ...(usedTxHash ? { usedTxHash } : {}),
      },
    };
  if (usedTxHash) return { kind: "used", trustedTime: latest.timestamp, txHash: usedTxHash };
  const result = await rpc.call("eth_call", [
    {
      to: intent.asset,
      data: encodeFunctionData({
        abi,
        functionName: "authorizationState",
        args: [payer as `0x${string}`, intent.nonce as `0x${string}`],
      }),
    },
    height(target.number),
  ]);
  requireWallet(
    typeof result === "string" && /^0x[0-9a-f]{64}$/i.test(result),
    "RPC_EVIDENCE_INVALID",
    "Authorization state must be an exact boolean.",
  );
  const used = decodeAbiParameters([{ type: "bool" }], result as `0x${string}`)[0];
  requireWallet(
    (await block(rpc, target.number)).hash === target.hash,
    "RPC_EVIDENCE_INVALID",
    "The proof block changed after the state read.",
  );
  if (cancellation) {
    requireWallet(used, "RPC_EVIDENCE_INVALID", "Cancellation contradicts authorization state.");
    return { kind: "canceled", trustedTime: latest.timestamp, proof: target };
  }
  requireWallet(
    !used,
    "RPC_EVIDENCE_INVALID",
    "Authorization state is used without complete matching event evidence.",
  );
  if (target.timestamp > intent.validBefore)
    return { kind: "expired", trustedTime: latest.timestamp, proof: target };
  return { kind: "pending", trustedTime: latest.timestamp };
}
