import { performance } from "node:perf_hooks";
import { readGeneralBalances, type GeneralBalanceAsset, type GeneralBalanceRpc, type GeneralBalanceSnapshot } from "../app/generalBalances.js";
import { inspectGeneralToken, type GeneralTokenInspection } from "../app/generalTokenInspection.js";
import { GeneralRpcScheduler } from "../app/generalRpcScheduler.js";
import { generalNetwork } from "../domain/generalNetworks.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { GENERAL_RPC_CONFIG_VERSION, generalRpcEndpoint } from "./generalRpcEndpoints.js";
import { GeneralRpcTransport } from "./generalRpcTransport.js";

export interface GeneralBalanceResult extends GeneralBalanceSnapshot {
  configVersion: number;
  fetchedAt: string;
  rpcChoice?: string;
}
type Flight = { controller: AbortController; users: number; promise: Promise<GeneralBalanceResult> };
type CacheEntry = { result: GeneralBalanceResult; at: number; bytes: number; entries: number; invalidated: boolean };
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 10000;
const CANCELED = () => new WalletError("BALANCE_READ_CANCELED", "Balance reading was canceled or timed out.");
function asStale(result: GeneralBalanceResult): GeneralBalanceResult {
  const previous = structuredClone(result), origin = { blockNumber: previous.blockNumber, blockHash: previous.blockHash,
    chainTimestamp: previous.chainTimestamp, fetchedAt: previous.fetchedAt };
  previous.assets = previous.assets.map((item) => ({ ...item, status: "stale" as const, previous: origin }));
  return previous;
}

/** New utility owns this display-only service; it never opens the payment runtime. */
export class GeneralBalanceService {
  private readonly scheduler = new GeneralRpcScheduler();
  private readonly shutdown = new AbortController();
  private readonly transports = new Map<string, GeneralBalanceRpc>();
  private readonly flights = new Map<string, Flight>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly attempts = new Map<string, number>();
  private cacheBytes = 0;
  private cacheEntries = 0;
  private active = 0;

  constructor(private readonly createTransport: (endpoint: string) => GeneralBalanceRpc = (url) => new GeneralRpcTransport(url),
    private readonly now: () => number = () => performance.now()) {}

  async read(input: { networkId: string; address: string; assets: readonly GeneralBalanceAsset[]; signal?: AbortSignal;
    /** Opaque, host-owned account and state generation binding. Absence disables sharing and caching. */
    cacheScope?: string; refresh?: boolean; rpcChoice?: string }): Promise<GeneralBalanceResult> {
    const network = generalNetwork(input.networkId);
    if (this.shutdown.signal.aborted || input.signal?.aborted) throw CANCELED();
    const rpcChoice = input.rpcChoice === undefined ? "default" : input.rpcChoice;
    generalRpcEndpoint(network.id, rpcChoice);
    requireWallet(typeof input.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(input.address) &&
      Array.isArray(input.assets) && input.assets.length <= 20 &&
      (input.cacheScope === undefined || typeof input.cacheScope === "string" && /^[0-9a-f]{64}$/.test(input.cacheScope)) &&
      (input.refresh === undefined || typeof input.refresh === "boolean"), "INVALID_REQUEST", "Invalid balance request.");
    const assets = structuredClone(input.assets);
    let key: string | undefined, throttleKey: string | undefined;
    if (input.cacheScope) {
      try {
        throttleKey = JSON.stringify([input.cacheScope, network.id, input.address.toLowerCase(), GENERAL_RPC_CONFIG_VERSION, rpcChoice]);
        key = JSON.stringify([throttleKey, assets]);
      }
      catch { throw new WalletError("INVALID_REQUEST", "Invalid balance request."); }
      requireWallet(Buffer.byteLength(key) <= 8192, "INVALID_REQUEST", "Invalid balance request.");
    }
    const clock = this.now();
    requireWallet(Number.isFinite(clock) && clock >= 0, "BALANCE_UNAVAILABLE", "The balance clock is unavailable.");
    if (key) {
      const cached = this.cache.get(key);
      if (cached && !cached.invalidated && clock >= cached.at && clock - cached.at < (input.refresh === false ? 30000 : 2000)) {
        this.cache.delete(key); this.cache.set(key, cached);
        return structuredClone(cached.result);
      }
      if (cached?.invalidated && input.refresh === false && clock >= cached.at && clock - cached.at < 30000) return asStale(cached.result);
      // Retain expired data only as an explicitly stale fallback until bounded LRU eviction.
      if (cached && clock < cached.at) this.dropCache(key);
      const existing = this.flights.get(key);
      if (existing && !existing.controller.signal.aborted) return this.join(existing, input.signal);
    }
    if (this.active >= 2) throw new WalletError("BALANCE_BUSY", "The balance refresh queue is full.");
    if (throttleKey) {
      const last = this.attempts.get(throttleKey);
      requireWallet(last === undefined || clock >= last && clock - last >= 2000,
        "BALANCE_BUSY", "Balance refresh is temporarily rate limited.");
      this.attempts.delete(throttleKey);
      while (this.attempts.size >= MAX_CACHE_ENTRIES) this.attempts.delete(this.attempts.keys().next().value!);
      this.attempts.set(throttleKey, clock);
    }
    const rpc = this.transport(network.id, rpcChoice);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.shutdown.signal]);
    this.active++;
    let flight!: Flight;
    const stale = (): GeneralBalanceResult | undefined => {
      if (!key || signal.aborted) return undefined;
      const cached = this.cache.get(key), at = this.now();
      if (!cached || !Number.isFinite(at) || at < cached.at) return undefined;
      cached.invalidated = true;
      return asStale(cached.result);
    };
    const promise = readGeneralBalances({ networkId: network.id, address: input.address, assets, rpc, signal }).then((snapshot) => {
      const result: GeneralBalanceResult = { ...snapshot, configVersion: GENERAL_RPC_CONFIG_VERSION, fetchedAt: new Date().toISOString(),
        ...(rpcChoice === "default" ? {} : { rpcChoice }) };
      if (key && !signal.aborted && result.assets.every((asset) => asset.status === "fresh")) this.remember(key, result);
      else {
        const prior = stale();
        if (prior) result.assets = result.assets.map((item, index) =>
          item.status === "error" && prior.assets[index]?.status === "stale" ? prior.assets[index]! : item);
        // A known precision conflict makes the old snapshot unsuitable even for later fallback.
        if (key && result.assets.some((item) => item.status === "metadata_conflict")) this.dropCache(key);
      }
      return result;
    }).catch((error: unknown) => {
      const prior = stale();
      if (prior) return prior;
      throw error;
    }).finally(() => {
      this.active--;
      if (key && this.flights.get(key) === flight) this.flights.delete(key);
    });
    flight = { controller, users: 0, promise };
    if (key) this.flights.set(key, flight);
    void promise.catch(() => {});
    return this.join(flight, input.signal);
  }

  /** Inspect only the requested public token and account; the caller owns the user's explicit request. */
  async inspectToken(input: { networkId: string; address: string; contractAddress: string; signal?: AbortSignal; rpcChoice?: string }): Promise<GeneralTokenInspection> {
    const network = generalNetwork(input.networkId);
    if (this.shutdown.signal.aborted || input.signal?.aborted) throw CANCELED();
    const rpcChoice = input.rpcChoice === undefined ? "default" : input.rpcChoice;
    generalRpcEndpoint(network.id, rpcChoice);
    requireWallet(typeof input.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(input.address) &&
      typeof input.contractAddress === "string" && /^0x[0-9a-fA-F]{40}$/.test(input.contractAddress) &&
      !/^0x0{40}$/i.test(input.contractAddress), "INVALID_REQUEST", "Invalid token inspection request.");
    requireWallet(this.active < 2, "BALANCE_BUSY", "The balance refresh queue is full.");
    const clock = this.now(), key = JSON.stringify(["token-inspection", network.id, rpcChoice, input.address.toLowerCase(), input.contractAddress.toLowerCase()]);
    requireWallet(Number.isFinite(clock) && clock >= 0, "BALANCE_UNAVAILABLE", "The balance clock is unavailable.");
    const last = this.attempts.get(key);
    requireWallet(last === undefined || clock >= last && clock - last >= 2000, "BALANCE_BUSY", "Token inspection is temporarily rate limited.");
    this.attempts.delete(key);
    while (this.attempts.size >= MAX_CACHE_ENTRIES) this.attempts.delete(this.attempts.keys().next().value!);
    this.attempts.set(key, clock);
    const signal = input.signal ? AbortSignal.any([input.signal, this.shutdown.signal]) : this.shutdown.signal;
    this.active++;
    try { return await inspectGeneralToken({ ...input, networkId: network.id, rpc: this.transport(network.id, rpcChoice), signal }); }
    finally { this.active--; }
  }

  /** Chain and block validation only; no wallet address is sent to the candidate. */
  async probeRpc(networkId: string, rpcChoice: string, signal?: AbortSignal): Promise<{ networkId: string; rpcChoice: string; blockNumber: string; blockHash: string }> {
    requireWallet(typeof rpcChoice === "string" && rpcChoice.length > 0, "RPC_ENDPOINT_INVALID", "The network endpoint is unavailable.");
    const snapshot = await this.read({ networkId, rpcChoice, address: "0x0000000000000000000000000000000000000000", assets: [], signal });
    return { networkId: snapshot.networkId, rpcChoice, blockNumber: snapshot.blockNumber, blockHash: snapshot.blockHash };
  }

  private transport(networkId: string, rpcChoice: string): GeneralBalanceRpc {
    const key = JSON.stringify([networkId, rpcChoice]);
    let rpc = this.transports.get(key);
    if (!rpc) {
      rpc = this.scheduler.wrap(networkId, this.createTransport(generalRpcEndpoint(networkId, rpcChoice)));
      this.transports.set(key, rpc);
    }
    return rpc;
  }

  private join(flight: Flight, signal?: AbortSignal): Promise<GeneralBalanceResult> {
    if (signal?.aborted || this.shutdown.signal.aborted) {
      if (!flight.users) flight.controller.abort();
      return Promise.reject(CANCELED());
    }
    if (flight.users >= 32) return Promise.reject(new WalletError("BALANCE_BUSY", "The balance refresh queue is full."));
    flight.users++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (outcome: { ok: true; value: GeneralBalanceResult } | { ok: false; error: unknown }) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", cancel);
        flight.users--;
        if (!flight.users && !outcome.ok) flight.controller.abort();
        if (!outcome.ok) reject(outcome.error); else resolve(structuredClone(outcome.value));
      };
      const cancel = () => finish({ ok: false, error: CANCELED() });
      signal?.addEventListener("abort", cancel, { once: true });
      flight.promise.then((value) => {
        if (signal?.aborted || this.shutdown.signal.aborted) cancel();
        else finish({ ok: true, value });
      }, (error: unknown) => finish({ ok: false, error }));
      if (signal?.aborted || this.shutdown.signal.aborted) cancel();
    });
  }

  private dropCache(key: string): void {
    const old = this.cache.get(key);
    if (old) { this.cacheBytes -= old.bytes; this.cacheEntries -= old.entries; this.cache.delete(key); }
  }
  private remember(key: string, result: GeneralBalanceResult): void {
    const at = this.now(), value = structuredClone(result), bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value));
    const entries = Math.max(1, value.assets.length);
    if (!Number.isFinite(at) || at < 0 || bytes > MAX_CACHE_BYTES || entries > MAX_CACHE_ENTRIES) return;
    this.dropCache(key);
    while (this.cacheEntries + entries > MAX_CACHE_ENTRIES || this.cacheBytes + bytes > MAX_CACHE_BYTES)
      this.dropCache(this.cache.keys().next().value!);
    this.cache.set(key, { result: value, at, bytes, entries, invalidated: false }); this.cacheBytes += bytes; this.cacheEntries += entries;
  }

  close(): void {
    this.shutdown.abort();
    this.scheduler.close();
    this.transports.clear();
    this.cache.clear(); this.attempts.clear(); this.cacheBytes = 0; this.cacheEntries = 0;
  }
}
