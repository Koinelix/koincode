import { performance } from "node:perf_hooks";
import type { GeneralBalanceRpc } from "../app/generalBalances.js";
import { generalNetwork } from "../domain/generalNetworks.js";
import { assertGeneralSigningNetwork } from "../domain/generalSigningPolicy.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { generalRpcEndpoint } from "./generalRpcEndpoints.js";
import { GeneralRpcTransport } from "./generalRpcTransport.js";

const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/;
const evidence = new WeakMap<object, { account: string; networkId: string; nonce: number; started: number; isLive: () => boolean }>();
const failed = () => new WalletError("SIGNING_CONTINUITY_UNKNOWN", "The pending nonce evidence is unavailable.");
let activeReads = 0;

/** In-process utility owner only; no secret, signer or model-facing authority is exposed. */
export class GeneralPendingNonceReader {
  private readonly shutdown = new AbortController();
  private active = false;
  constructor(private readonly networkId: string,
    private readonly rpc: GeneralBalanceRpc = new GeneralRpcTransport(generalRpcEndpoint(networkId), undefined, "nonce"),
    private readonly now: () => number = () => Math.floor(performance.now())) {}

  async read(account: string, parent?: AbortSignal): Promise<{ nonce: number; evidence: object }> {
    const network = generalNetwork(this.networkId);
    assertGeneralSigningNetwork(network.id, BigInt(network.chainId));
    requireWallet(typeof account === "string" && /^0x[0-9a-f]{40}$/.test(account) && !/^0x0{40}$/.test(account),
      "SIGNING_CONTINUITY_UNKNOWN", "The pending nonce account is invalid.");
    const started = this.now();
    requireWallet(Number.isSafeInteger(started) && started >= 0 && started <= Number.MAX_SAFE_INTEGER - 20000,
      "SIGNING_CONTINUITY_UNKNOWN", "The pending nonce clock is unavailable.");
    requireWallet(!this.active && activeReads < 2 && !this.shutdown.signal.aborted,
      "GENERAL_OPERATION_BUSY", "Pending nonce readers are unavailable or busy.");
    this.active = true; activeReads++;
    const pending = new Set<Promise<unknown>>();
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(20000), ...(parent ? [parent] : [])]);
    const call = async (method: string, params: readonly unknown[]): Promise<unknown> => {
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
      if (bounded.aborted) throw failed();
      let cancel = () => {};
      const canceled = new Promise<never>((_, reject) => {
        cancel = () => reject(failed());
        bounded.addEventListener("abort", cancel, { once: true });
        if (bounded.aborted) cancel();
      });
      const work = Promise.resolve().then(() => { if (bounded.aborted) throw failed(); return this.rpc.call(method, params, bounded); });
      pending.add(work);
      void work.then(() => pending.delete(work), () => pending.delete(work));
      try { return await Promise.race([work, canceled]); }
      finally { bounded.removeEventListener("abort", cancel); }
    };
    try {
      const before = await call("eth_chainId", []);
      requireWallet(typeof before === "string" && QUANTITY.test(before) && BigInt(before) === BigInt(network.chainId),
        "SIGNING_CONTINUITY_UNKNOWN", "The pending nonce network is invalid.");
      const raw = await call("eth_getTransactionCount", [account, "pending"]);
      requireWallet(typeof raw === "string" && QUANTITY.test(raw) && BigInt(raw) <= BigInt(Number.MAX_SAFE_INTEGER),
        "SIGNING_CONTINUITY_UNKNOWN", "The pending nonce is invalid.");
      const after = await call("eth_chainId", []), current = this.now();
      requireWallet(typeof after === "string" && QUANTITY.test(after) && BigInt(after) === BigInt(network.chainId) &&
        Number.isSafeInteger(current) && current >= started && current - started < 20000 && !signal.aborted,
      "SIGNING_CONTINUITY_UNKNOWN", "The pending nonce evidence is stale.");
      const nonce = Number(BigInt(raw)), ticket = Object.freeze({});
      evidence.set(ticket, { account, networkId: network.id, nonce, started, isLive: () => !signal.aborted });
      return { nonce, evidence: ticket };
    } catch { throw failed(); }
    finally {
      const release = () => { this.active = false; activeReads--; };
      if (pending.size) void Promise.allSettled(pending).then(release); else release();
    }
  }

  close(): void { this.shutdown.abort(); }
}

/** One use only; callers must bind it to the current journal, account, network and clock. */
export function consumeGeneralPendingNonce(value: object, account: string, networkId: string, now: number): {
  nonce: number; startedAt: number; expiresAt: number; isLive: () => boolean;
} {
  const item = value && typeof value === "object" ? evidence.get(value) : undefined;
  if (value && typeof value === "object") evidence.delete(value);
  requireWallet(item && item.account === account && item.networkId === networkId && item.isLive() &&
    Number.isSafeInteger(now) && now >= item.started && now - item.started < 20000,
  "SIGNING_CONTINUITY_UNKNOWN", "The pending nonce evidence is invalid or expired.");
  return { nonce: item.nonce, startedAt: item.started, expiresAt: item.started + 20000, isLive: item.isLive };
}
