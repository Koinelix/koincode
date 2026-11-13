import { WalletSnapshotBatch } from "./walletSnapshotBatch.js";
import type { UptoChainSnapshot } from "../app/ports.js";
import { allowanceRpc } from "./allowanceRpc.js";
import { RpcSession, type RpcRead } from "./rpcSession.js";
export { RpcSession, type RpcRead } from "./rpcSession.js";
import { verifyUptoReceipt } from "./uptoReceiptEvidence.js";
import { PERMIT2_ADDRESS } from "../domain/uptoAuthorization.js";
import { resolveAuthorization } from "./authorizationResolution.js";
import { chainHeight, chainBlock } from "./chainValues.js";
export { chainHeight, chainBlock } from "./chainValues.js";
import { performance } from "node:perf_hooks";
import { decodeAbiParameters, encodeFunctionData, parseAbi } from "viem";
import type { ChainBlock, ChainSnapshot, SettlementResult, WalletChain } from "../app/ports.js";
import type { Network, PaymentIntent } from "../domain/model.js";
import { verifyUsedReceipt } from "./receiptEvidence.js";
import { verifyHistoryPage } from "./historyRpc.js";
import type { HistoryPageInput, HistoryPageResult } from "../app/ports.js";
import { networkConfig } from "../domain/networks.js";
import { requireWallet, WalletError } from "../domain/errors.js";
const TOKEN = parseAbi([
  "function balanceOf(address) view returns(uint256)",
  "function decimals() view returns(uint8)",
  "function name() view returns(string)",
  "function version() view returns(string)",
]);
const SETTLEMENT_ANCHOR_LIMIT = 64;
const FINAL_ANCHOR_CACHE_LIMIT = 4096;
const hexHeight = (number: number) => "0x" + number.toString(16);
export class BaseWalletChain implements WalletChain {
  readonly allowanceTransactions = allowanceRpc;
  readonly #uptoReads = new WalletSnapshotBatch<UptoChainSnapshot>();
  readonly #balanceReads = new WalletSnapshotBatch<ChainSnapshot>();
  #nextAt = 0;
  #inflight = 0;
  /** Immutable endpoint facts verified in this process; balances, allowances, nonces and heads are always read. */
  readonly #chainVerified = new Set<string>();
  readonly #assetVerified = new Set<string>();
  /** Settlement anchors proven canonical at or below a checked finalized head; memory only. */
  readonly #finalAnchors = new Set<string>();
  constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch) {}
  async historyPage(input: HistoryPageInput, signal?: AbortSignal): Promise<HistoryPageResult> {
    requireWallet(this.#inflight < 16, "RPC_BUSY", "The recovery RPC queue is full.");
    this.#inflight++;
    try {
      return await verifyHistoryPage(this.session(input.network, signal), input);
    } finally {
      this.#inflight--;
    }
  }
  private static assertHead(current: ChainBlock, head: ChainBlock): void {
    requireWallet(
      current.number === head.number &&
        current.hash === head.hash &&
        current.timestamp === head.timestamp,
      "RPC_EVIDENCE_INVALID",
      "A confirmation anchor changed during verification.",
    );
  }
  private async checkHeads(rpc: RpcSession, heads: ChainBlock[]): Promise<void> {
    for (const head of heads) {
      requireWallet(
        heads.every(
          (other) =>
            other.number !== head.number ||
            (other.hash === head.hash && other.timestamp === head.timestamp),
        ),
        "RPC_EVIDENCE_INVALID",
        "Same-height confirmation evidence contradicts the canonical block.",
      );
    }
    const current = await rpc.batch(heads.map(head => ({ method: "eth_getBlockByNumber", params: [hexHeight(head.number), false] })));
    heads.forEach((head, index) => BaseWalletChain.assertHead(chainBlock(current[index]), head));
  }
  private endpointKey(network: Network): string {
    return `${networkConfig(network).endpoint}|${network}`;
  }
  /** Prepends eth_chainId unless this process already verified the endpoint's chain. */
  private chainRead(network: Network): RpcRead[] {
    return this.#chainVerified.has(this.endpointKey(network)) ? [] : [{ method: "eth_chainId", params: [] }];
  }
  private verifyChain(network: Network, results: unknown[], requested: number): unknown[] {
    if (!requested) return results;
    requireWallet(chainHeight(results[0]) === networkConfig(network).chainId,
      "RPC_CHAIN_MISMATCH", "The RPC returned a different chain.");
    this.#chainVerified.add(this.endpointKey(network));
    return results.slice(1);
  }
  async canonicalSettlementAnchors(snapshot: ChainSnapshot,
    anchors: ReadonlyArray<{ number: number; hash: string }>, signal?: AbortSignal): Promise<Array<{ number: number; hash: string }>> {
    requireWallet(this.#inflight < 16 && anchors.length <= SETTLEMENT_ANCHOR_LIMIT, "RPC_BUSY", "The settlement proof request is invalid or busy.");
    for (const anchor of anchors) {
      requireWallet(Number.isSafeInteger(anchor.number) && anchor.number >= 0 &&
        anchor.number <= snapshot.latest.number && /^0x[0-9a-f]{64}$/i.test(anchor.hash),
      "RPC_EVIDENCE_INVALID", "The settlement anchor is invalid.");
    }
    const key = (anchor: { number: number; hash: string }) => `${snapshot.network}:${anchor.number}:${anchor.hash.toLowerCase()}`;
    const final = (anchor: { number: number; hash: string }) =>
      anchor.number <= snapshot.finalized.number && this.#finalAnchors.has(key(anchor));
    const pending = anchors.filter(anchor => !final(anchor));
    const verified = new Set<string>();
    if (pending.length) {
      this.#inflight++;
      try {
        const rpc = this.session(snapshot.network, signal), chain = this.chainRead(snapshot.network);
        const results = this.verifyChain(snapshot.network, await rpc.batch([
          ...chain,
          { method: "eth_getBlockByNumber", params: [hexHeight(snapshot.latest.number), false] },
          ...pending.map(anchor => ({ method: "eth_getBlockByNumber", params: [hexHeight(anchor.number), false] })),
        ]), chain.length);
        BaseWalletChain.assertHead(chainBlock(results[0]), snapshot.latest);
        pending.forEach((anchor, index) => {
          const block = chainBlock(results[index + 1]);
          if (block.number === anchor.number && block.hash === anchor.hash.toLowerCase()) verified.add(key(anchor));
        });
        await this.checkHeads(rpc, [snapshot.latest]);
      } finally { this.#inflight--; }
      for (const anchor of pending) {
        if (!verified.has(key(anchor)) || anchor.number > snapshot.finalized.number) continue;
        if (this.#finalAnchors.size >= FINAL_ANCHOR_CACHE_LIMIT) this.#finalAnchors.delete(this.#finalAnchors.values().next().value!);
        this.#finalAnchors.add(key(anchor));
      }
    }
    return anchors.filter(anchor => final(anchor) || verified.has(key(anchor)))
      .map(anchor => ({ number: anchor.number, hash: anchor.hash.toLowerCase() }));
  }
  async resolveAuthorization(intent: PaymentIntent, payer: string, signal?: AbortSignal): Promise<import("../app/ports.js").AuthorizationResolution> {
    if (intent.upto) {
      const snapshot = await this.uptoSnapshot(intent.network, payer, [intent.nonce], signal);
      const nonceUsed = snapshot.usedNonces.includes(intent.nonce);
      if (intent.proofBlock !== undefined && intent.proofHash) {
        const proofs = await this.canonicalSettlementAnchors(snapshot, [{ number: intent.proofBlock, hash: intent.proofHash }], signal);
        if (!proofs.length) return { kind: "proof_reorg", trustedTime: snapshot.latest.timestamp, ...(nonceUsed ? { uptoNonceUsed: true } : {}) };
      }
      if (nonceUsed) return intent.settlementTx
        ? { kind: "used", trustedTime: snapshot.latest.timestamp, txHash: intent.settlementTx }
        : { kind: "pending", trustedTime: snapshot.latest.timestamp, uptoNonceUsed: true };
      if (snapshot.finalized.timestamp > intent.validBefore) return { kind: "expired", trustedTime: snapshot.latest.timestamp, proof: snapshot.finalized };
      return { kind: "pending", trustedTime: snapshot.latest.timestamp };
    }
    requireWallet(this.#inflight < 16, "RPC_BUSY", "The wallet RPC queue is full.");
    this.#inflight++;
    try {
      const rpc = this.session(intent.network, signal);
      requireWallet(
        chainHeight(await rpc.call("eth_chainId", [])) === networkConfig(intent.network).chainId,
        "RPC_CHAIN_MISMATCH",
        "The evidence RPC returned another chain.",
      );
      return await resolveAuthorization(rpc, intent, payer);
    } finally {
      this.#inflight--;
    }
  }
  async settlement(
    intent: PaymentIntent,
    payer: string,
    txHash: string,
    signal?: AbortSignal,
  ): Promise<SettlementResult> {
    requireWallet(this.#inflight < 16, "RPC_BUSY", "The wallet RPC queue is full.");
    this.#inflight++;
    try {
      const rpc = this.session(intent.network, signal);
      requireWallet(
        chainHeight(await rpc.call("eth_chainId", [])) === networkConfig(intent.network).chainId,
        "RPC_CHAIN_MISMATCH",
        "The evidence RPC returned another chain.",
      );
      const latest = chainBlock(await rpc.call("eth_getBlockByNumber", ["latest", false]));
      const safe = chainBlock(await rpc.call("eth_getBlockByNumber", ["safe", false]));
      requireWallet(
        safe.number <= latest.number && safe.timestamp <= latest.timestamp,
        "RPC_EVIDENCE_INVALID",
        "Confirmation heads are inconsistent.",
      );
      if ((intent.spent || intent.status === "OBSERVED") && intent.settlementBlock !== undefined && intent.settlementHash) {
        const block = chainBlock(
          await rpc.call("eth_getBlockByNumber", [
            "0x" + intent.settlementBlock.toString(16),
            false,
          ]),
        );
        if (block.hash !== intent.settlementHash) {
          await this.checkHeads(rpc, [latest, safe, block]);
          return { kind: "orphaned", trustedTime: latest.timestamp };
        }
      }
      const evidence = intent.upto ? await verifyUptoReceipt(rpc, intent, payer, txHash) : await verifyUsedReceipt(rpc, intent, payer, txHash);
      if (evidence) {
        requireWallet(
          evidence.block.number <= latest.number && evidence.block.timestamp <= latest.timestamp,
          "RPC_EVIDENCE_INVALID",
          "Settlement is newer than the observed chain head.",
        );
        await this.checkHeads(rpc, [latest, safe, evidence.block]);
        return {
          kind: "used",
          trustedTime: latest.timestamp,
          ...evidence,
          safe: evidence.block.number <= safe.number,
        };
      }
      await this.checkHeads(rpc, [latest, safe]);
      return { kind: "pending", trustedTime: latest.timestamp };
    } finally {
      this.#inflight--;
    }
  }
  session(network: Network, signal?: AbortSignal, beforeRead?: () => void): RpcSession {
    const endpoint = networkConfig(network).endpoint;
    return new RpcSession(
      endpoint,
      this.fetchImpl,
      async (signal, cost = 1) => {
        const now = performance.now(),
          slot = Math.max(now, this.#nextAt);
        requireWallet(slot - now <= 15000, "RPC_BUSY", "The wallet RPC queue is full.");
        // Public endpoints limit batch items, not HTTP requests; keep about 20 items per second.
        this.#nextAt = slot + Math.max(100, cost * 50);
        if (slot > now)
          await new Promise<void>((resolve, reject) => {
            const abort = () => {
              clearTimeout(timer);
              reject(new WalletError("WALLET_OPERATION_ABORTED", "The RPC request was canceled."));
            };
            const timer = setTimeout(() => {
              signal?.removeEventListener("abort", abort);
              resolve();
            }, slot - now);
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
          });
        requireWallet(
          !signal?.aborted,
          "WALLET_OPERATION_ABORTED",
          "The RPC request was canceled.",
        );
        beforeRead?.();
      },
      signal,
    );
  }
  async uptoSnapshot(network: Network, payer: string, nonces: readonly string[], signal?: AbortSignal, at: "latest" | "finalized" = "latest"): Promise<import("../app/ports.js").UptoChainSnapshot> {
    requireWallet(nonces.length <= 1024 && nonces.every(nonce => /^0x[0-9a-f]{64}$/.test(nonce)),
      "RPC_BUDGET_EXHAUSTED", "The nonce observation exceeds its bounded RPC budget.");
    const requested = [...nonces];
    const result = await this.#uptoReads.read(JSON.stringify([network, payer.toLowerCase(), at]), requested, signal,
      (combined, active, seal) => this.readUpto(network, payer.toLowerCase(), combined, active, at, seal));
    const used = new Set(result.usedNonces);
    result.usedNonces = requested.filter(nonce => used.has(nonce));
    return result;
  }
  private async readUpto(network: Network, payer: string, nonces: ReadonlySet<string>, signal: AbortSignal,
    at: "latest" | "finalized", seal: () => void): Promise<UptoChainSnapshot> {
    const abi = parseAbi([
      "function allowance(address owner,address spender) view returns(uint256)",
      "function nonces(address owner) view returns(uint256)",
      "function nonceBitmap(address owner,uint256 wordPos) view returns(uint256)",
    ]);
    let words: string[] = [];
    const asset = networkConfig(network).asset;
    const { snapshot, extra } = await this.anchored(network, payer, signal, block => {
      words = [...new Set(Array.from(nonces, nonce => (BigInt(nonce) >> 8n).toString()))];
      const read = (target: string, name: "allowance" | "nonces" | "nonceBitmap", args: readonly unknown[]): RpcRead =>
        ({ method: "eth_call", params: [{ to: target, data: encodeFunctionData({ abi, functionName: name, args: args as never }) }, block] });
      return [
        read(asset, "allowance", [payer, PERMIT2_ADDRESS]),
        read(asset, "nonces", [payer]),
        ...words.map(word => read(PERMIT2_ADDRESS, "nonceBitmap", [payer, BigInt(word)])),
      ];
    }, at, seal);
    const [allowance, permitNonce, ...bitmaps] = extra.map(value => {
      requireWallet(typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value), "RPC_EVIDENCE_INVALID", "The anchored uint256 read is invalid.");
      return BigInt(value);
    });
    const bitmapByWord = new Map(words.map((word, index) => [word, bitmaps[index]!]));
    const usedNonces = [...nonces].filter(nonce => {
      const value = BigInt(nonce);
      return (bitmapByWord.get((value >> 8n).toString())! & (1n << (value & 255n))) !== 0n;
    });
    return { ...snapshot, allowanceAtomic: allowance!.toString(), permitNonce: permitNonce!.toString(), usedNonces, nonceBitmaps: bitmapByWord };
  }
  async snapshot(network: Network, payer: string, signal?: AbortSignal): Promise<ChainSnapshot> {
    return this.#balanceReads.read(JSON.stringify([network, payer.toLowerCase()]), [], signal,
      async (_, active, seal) => (await this.anchored(network, payer.toLowerCase(), active, () => [], "latest", seal)).snapshot);
  }
  /**
   * One anchored observation in three round trips: chain and heads; every state read pinned to latest;
   * then the same heads again. Extra reads share the anchor and the post-read head check.
   */
  private async anchored(network: Network, payer: string, signal: AbortSignal | undefined,
    extra: (block: string) => RpcRead[], at: "latest" | "finalized" = "latest", seal?: () => void): Promise<{ snapshot: ChainSnapshot; extra: unknown[] }> {
    requireWallet(
      this.#inflight < 16 && /^0x[0-9a-f]{40}$/i.test(payer),
      "RPC_BUSY",
      "The wallet RPC request is invalid or busy.",
    );
    this.#inflight++;
    try {
      const rpc = this.session(network, signal, seal),
        config = networkConfig(network),
        chain = this.chainRead(network);
      const heads = this.verifyChain(network, await rpc.batch([
        ...chain,
        { method: "eth_getBlockByNumber", params: ["latest", false] },
        { method: "eth_getBlockByNumber", params: ["safe", false] },
        { method: "eth_getBlockByNumber", params: ["finalized", false] },
      ]), chain.length);
      const [latest, safe, finalized] = heads.map(chainBlock) as [ChainBlock, ChainBlock, ChainBlock];
      requireWallet(
        latest.number >= safe.number &&
          safe.number >= finalized.number &&
          latest.timestamp >= safe.timestamp &&
          safe.timestamp >= finalized.timestamp,
        "RPC_EVIDENCE_INVALID",
        "The RPC confirmation heads are inconsistent.",
      );
      const block = hexHeight(at === "latest" ? latest.number : finalized.number), assetKnown = this.#assetVerified.has(this.endpointKey(network));
      const call = (functionName: "balanceOf" | "decimals" | "name" | "version"): RpcRead => ({
        method: "eth_call",
        params: [{ to: config.asset, data: encodeFunctionData({
          abi: TOKEN,
          functionName,
          ...(functionName === "balanceOf" ? { args: [payer as `0x${string}`] } : {}),
        }) }, block],
      });
      const metadata = assetKnown ? [] : [call("decimals"), call("name"), call("version")];
      const extraReads = extra(block);
      const results = await rpc.batch([...metadata, call("balanceOf"), ...extraReads]);
      const token = (result: unknown) => {
        requireWallet(
          typeof result === "string" && /^0x[0-9a-f]*$/i.test(result),
          "RPC_EVIDENCE_INVALID",
          "The token read result is invalid.",
        );
        return result as `0x${string}`;
      };
      if (!assetKnown) {
        const [decimalsData, nameData, versionData] = results.slice(0, 3).map(token) as [`0x${string}`, `0x${string}`, `0x${string}`];
        requireWallet(
          decodeAbiParameters([{ type: "uint8" }], decimalsData)[0] === config.assetDecimals,
          "RPC_ASSET_MISMATCH",
          "The trusted asset decimals differ from the configured asset.",
        );
        requireWallet(
          decodeAbiParameters([{ type: "string" }], nameData)[0] === config.domainName &&
            decodeAbiParameters([{ type: "string" }], versionData)[0] === config.domainVersion,
          "RPC_ASSET_MISMATCH",
          "The token domain differs from the trusted asset.",
        );
      }
      const balance = decodeAbiParameters([{ type: "uint256" }], token(results[metadata.length]))[0];
      await this.checkHeads(rpc, [latest, safe, finalized]);
      if (!assetKnown) this.#assetVerified.add(this.endpointKey(network));
      return {
        snapshot: {
          network,
          asset: config.asset,
          payer: payer.toLowerCase(),
          latest,
          safe,
          finalized,
          balanceAtomic: balance.toString(),
        },
        extra: results.slice(metadata.length + 1),
      };
    } finally {
      this.#inflight--;
    }
  }
}
