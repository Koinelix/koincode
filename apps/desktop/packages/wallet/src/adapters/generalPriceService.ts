import { WalletError, requireWallet } from "../domain/errors.js";
import { generalNetwork } from "../domain/generalNetworks.js";

type PriceIdentity = { kind: "coin"; id: string } | { kind: "token"; platform: string; contract: string };
export type GeneralPriceRequest = { assetId: string; networkId: string; identity: PriceIdentity };
export type GeneralPriceQuote = { assetId: string; currency: "USD"; priceDecimal: string | null;
  provider: "coingecko"; providerTimestamp: number | null; fetchedAt: number | null;
  status: "fresh" | "stale" | "unavailable" };

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const MAX_RESPONSE = 256 * 1024;
const MAX_CACHE = 512;
const PRICE_SOURCE = Symbol("priceSource");
const unavailable = (assetId: string): GeneralPriceQuote => ({ assetId, currency: "USD", priceDecimal: null,
  provider: "coingecko", providerTimestamp: null, fetchedAt: null, status: "unavailable" });

/** Preserve a JSON number's decimal value without converting through floating point. */
function decimal(source: string): string | null {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]{1,3}))?$/.exec(source);
  if (!match) return null;
  const fraction = match[2] ?? "", exponent = Number(match[3] ?? "0");
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 100) return null;
  let digits = match[1]! + fraction, point = match[1]!.length + exponent;
  if (point <= 0) { digits = "0".repeat(-point) + digits; point = 0; }
  if (point >= digits.length) digits += "0".repeat(point - digits.length);
  let integer = (digits.slice(0, point) || "0").replace(/^0+(?=\d)/, "");
  const trailing = digits.slice(point).replace(/0+$/, "");
  if (integer.length > 36 || trailing.length > 36) return null;
  if (!integer) integer = "0";
  return trailing ? `${integer}.${trailing}` : integer;
}

function parseResponse(text: string, requested: Set<string>, now: number): Map<string, { price: string; updated: number }> {
  const result = new Map<string, { price: string; updated: number }>();
  let value: unknown;
  try {
    value = JSON.parse(text, (key: string, current: unknown, context?: { source?: string }) =>
      key === "usd" && typeof current === "number" ? { [PRICE_SOURCE]: context?.source } : current);
  } catch { return result; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [key, item] of Object.entries(value)) {
    if (!requested.has(key) || !item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>, price = row.usd as { [PRICE_SOURCE]?: unknown } | null;
    const raw = price && typeof price === "object" ? price[PRICE_SOURCE] : undefined;
    const parsed = typeof raw === "string" ? decimal(raw) : null, updated = row.last_updated_at;
    if (parsed === null || typeof updated !== "number" || !Number.isSafeInteger(updated) || updated < 0 || updated * 1000 > now + 30000) continue;
    result.set(key, { price: parsed, updated: updated * 1000 });
  }
  return result;
}

/** Display-only price reader. The caller must map assets to verified provider identities. */
export class GeneralPriceService {
  private readonly cache = new Map<string, GeneralPriceQuote>();
  private readonly shutdown = new AbortController();
  private readonly config: Readonly<{ mode: "demo" | "pro"; apiKey: string }>;
  private active = false;
  constructor(config: { mode: "demo" | "pro"; apiKey: string },
    private readonly transport: typeof fetch = fetch, private readonly now: () => number = Date.now) {
    requireWallet((config.mode === "demo" || config.mode === "pro") && typeof config.apiKey === "string" &&
      /^[A-Za-z0-9_-]{1,256}$/.test(config.apiKey), "PRICE_CONFIG_INVALID", "Price configuration is invalid.");
    this.config = Object.freeze({ mode: config.mode, apiKey: config.apiKey });
  }

  async read(requests: readonly GeneralPriceRequest[], signal?: AbortSignal): Promise<GeneralPriceQuote[]> {
    requireWallet(!this.shutdown.signal.aborted && !signal?.aborted && !this.active && Array.isArray(requests) &&
      requests.length <= 20, "PRICE_UNAVAILABLE", "Price reading is unavailable.");
    const now = this.now(), seen = new Set<string>();
    requireWallet(Number.isSafeInteger(now) && now >= 0, "PRICE_UNAVAILABLE", "Price reading is unavailable.");
    const pending = new Map<string, { identity: PriceIdentity; targets: string[] }>(), output = new Map<string, GeneralPriceQuote>();
    const requestedIds: string[] = [];
    for (const request of requests) {
      requireWallet(request && typeof request.assetId === "string" && request.assetId.length > 0 && request.assetId.length <= 256 &&
        !seen.has(request.assetId) && request.identity &&
        (request.identity.kind === "coin" && NAME.test(request.identity.id) && request.identity.id.length <= 100 ||
         request.identity.kind === "token" && NAME.test(request.identity.platform) && request.identity.platform.length <= 100 && ADDRESS.test(request.identity.contract)),
      "PRICE_INPUT_INVALID", "Price identities are invalid.");
      requireWallet(!generalNetwork(request.networkId).testnet, "PRICE_INPUT_INVALID", "Testnet assets are not valued in USD.");
      seen.add(request.assetId);
      requestedIds.push(request.assetId);
      const identity: PriceIdentity = request.identity.kind === "coin" ? { kind: "coin", id: request.identity.id } :
        { kind: "token", platform: request.identity.platform, contract: request.identity.contract };
      const key = JSON.stringify(identity), cached = this.cache.get(key);
      if (cached && cached.fetchedAt !== null && now >= cached.fetchedAt && now - cached.fetchedAt < 60000) {
        output.set(request.assetId, { ...cached, assetId: request.assetId,
          status: cached.providerTimestamp !== null && now - cached.providerTimestamp > 300000 ? "stale" : "fresh" });
      } else {
        if (cached?.fetchedAt !== null && cached?.fetchedAt !== undefined && now < cached.fetchedAt) this.cache.delete(key);
        const prior = this.cache.get(key);
        output.set(request.assetId, prior ? { ...prior, assetId: request.assetId, status: "stale" } : unavailable(request.assetId));
        const group = pending.get(key) ?? { identity, targets: [] as string[] };
        group.targets.push(request.assetId); pending.set(key, group);
      }
    }
    this.active = true;
    try {
      const overall = AbortSignal.timeout(20000);
      let lastClock = now;
      const groups = new Map<string, Array<[string, { identity: PriceIdentity; targets: string[] }]>>();
      for (const entry of pending) {
        const identity = entry[1].identity, group = identity.kind === "coin" ? "coin" : `token:${identity.platform}`;
        const existing = groups.get(group) ?? []; existing.push(entry); groups.set(group, existing);
      }
      for (const [group, items] of groups) {
        if (this.shutdown.signal.aborted || signal?.aborted) throw new WalletError("PRICE_UNAVAILABLE", "Price reading was canceled.");
        if (overall.aborted) break;
        const identifiers = items.map(([, item]) => item.identity.kind === "coin" ? item.identity.id : item.identity.contract);
        const root = this.config.mode === "demo" ? "https://api.coingecko.com/api/v3" : "https://pro-api.coingecko.com/api/v3";
        const url = new URL(group === "coin" ? `${root}/simple/price` : `${root}/simple/token_price/${group.slice(6)}`);
        url.searchParams.set(group === "coin" ? "ids" : "contract_addresses", identifiers.join(","));
        url.searchParams.set("vs_currencies", "usd"); url.searchParams.set("include_last_updated_at", "true");
        let values = new Map<string, { price: string; updated: number }>();
        try {
          const requestSignal = AbortSignal.any([this.shutdown.signal, overall, AbortSignal.timeout(8000), ...(signal ? [signal] : [])]);
          const response = await this.transport(url, { method: "GET", redirect: "error", signal: requestSignal,
            headers: { [this.config.mode === "demo" ? "x-cg-demo-api-key" : "x-cg-pro-api-key"]: this.config.apiKey } });
          if (!response.ok || !response.body) throw new Error("Price request failed");
          const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
          try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length;
            if (size > MAX_RESPONSE) throw new Error("Price response too large"); chunks.push(part.value); } }
          finally { await reader.cancel().catch(() => {}); }
          values = parseResponse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)), new Set(identifiers), now);
        } catch { /* Missing quotes do not affect the separately owned balance service. */ }
        if (this.shutdown.signal.aborted || signal?.aborted) throw new WalletError("PRICE_UNAVAILABLE", "Price reading was canceled.");
        const observedAt = this.now();
        requireWallet(Number.isSafeInteger(observedAt) && observedAt >= lastClock, "PRICE_UNAVAILABLE", "Price clock changed during reading.");
        lastClock = observedAt;
        for (let index = 0; index < items.length; index++) {
          const [key, item] = items[index]!, value = values.get(identifiers[index]!);
          const saved = this.cache.get(key), quote: GeneralPriceQuote = value ? { assetId: item.targets[0]!, currency: "USD",
            priceDecimal: value.price, provider: "coingecko", providerTimestamp: value.updated, fetchedAt: observedAt,
            status: observedAt - value.updated > 300000 ? "stale" : "fresh" } : saved ? { ...saved, status: "stale" } : unavailable(item.targets[0]!);
          if (value) { this.cache.delete(key); this.cache.set(key, quote); while (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value!); }
          for (const target of item.targets) output.set(target, { ...quote, assetId: target });
        }
      }
      return requestedIds.map((assetId) => output.get(assetId) ?? unavailable(assetId));
    } finally { this.active = false; }
  }
  close(): void { this.shutdown.abort(); this.cache.clear(); }
}
