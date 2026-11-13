import type { GeneralBalanceAsset } from "../app/generalBalances.js";
import { generalNetwork } from "../domain/generalNetworks.js";
import { generalUsdEstimate } from "../domain/generalPriceMath.js";
import { requireWallet } from "../domain/errors.js";
import { generalPriceRequest } from "./generalPriceIdentity.js";
import type { GeneralPriceQuote } from "./generalPriceService.js";

type BalanceStatus = "fresh" | "stale" | "error" | "unsupported" | "metadata_conflict";
export type GeneralPortfolioAssetRow = { networkId: string; asset: GeneralBalanceAsset; amountAtomic: string | null; decimals: number | null;
  precision: "verified" | "user" | "unknown"; status: BalanceStatus; observedAt: number | null };
export type GeneralPortfolioView = { accountId: string; generation: number; visibleNetworks: string[] };
export type GeneralPortfolioNetworkCoverage = { networkId: string; status: "fresh" | "stale" | "error" };
export type GeneralPortfolioPriceReader = { read(assets: readonly { networkId: string; asset: GeneralBalanceAsset }[], signal?: AbortSignal): Promise<Array<GeneralPriceQuote | null>> };

const ATOMIC = /^(0|[1-9][0-9]{0,77})$/;
const MAX_UINT256 = (1n << 256n) - 1n;

/** Derives display rows and total from one frozen view. It never supplies payment evidence. */
export async function generalPortfolioValuation(input: { view: GeneralPortfolioView; assets: readonly GeneralPortfolioAssetRow[];
  networkCoverage: readonly GeneralPortfolioNetworkCoverage[]; prices?: GeneralPortfolioPriceReader;
  isCurrent: (view: GeneralPortfolioView) => boolean; signal?: AbortSignal }) {
  const view = structuredClone(input.view), rows = structuredClone(input.assets), coverage = structuredClone(input.networkCoverage);
  requireWallet(view && typeof view.accountId === "string" && view.accountId.length > 0 && view.accountId.length <= 128 &&
    Number.isSafeInteger(view.generation) && view.generation >= 0 && Array.isArray(view.visibleNetworks) &&
    view.visibleNetworks.length <= 14 && new Set(view.visibleNetworks).size === view.visibleNetworks.length &&
    Array.isArray(rows) && rows.length <= 200 && Array.isArray(coverage) && coverage.length <= 7 &&
    typeof input.isCurrent === "function", "PRICE_INPUT_INVALID", "Invalid portfolio view.");
  for (const networkId of view.visibleNetworks) generalNetwork(networkId);
  const visibleMainnets = view.visibleNetworks.filter((id) => !generalNetwork(id).testnet);
  requireWallet(coverage.length === visibleMainnets.length && new Set(coverage.map((item) => item?.networkId)).size === coverage.length &&
    coverage.every((item) => item && visibleMainnets.includes(item.networkId) && ["fresh", "stale", "error"].includes(item.status)),
  "PRICE_INPUT_INVALID", "Network coverage does not match the portfolio view.");
  const deadline = AbortSignal.timeout(20000), signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  const current = () => requireWallet(!signal.aborted && input.isCurrent(structuredClone(view)) === true,
    "PRICE_VIEW_CHANGED", "The portfolio view is no longer current.");
  current();
  const visible = new Set(view.visibleNetworks), identities = new Set<string>();
  const plan = rows.flatMap((row) => {
    requireWallet(row && typeof row.networkId === "string", "PRICE_INPUT_INVALID", "Invalid portfolio asset.");
    const network = generalNetwork(row.networkId);
    if (!visible.has(network.id) || network.testnet) return [];
    const request = generalPriceRequest(network.id, row.asset);
    requireWallet(request && !identities.has(request.assetId) &&
      ["fresh", "stale", "error", "unsupported", "metadata_conflict"].includes(row.status) &&
      ["verified", "user", "unknown"].includes(row.precision) &&
      (row.observedAt === null || Number.isSafeInteger(row.observedAt) && row.observedAt >= 0) &&
      (row.status !== "fresh" && row.status !== "stale" || row.observedAt !== null && row.amountAtomic !== null) &&
      (row.amountAtomic === null || typeof row.amountAtomic === "string" && ATOMIC.test(row.amountAtomic) && BigInt(row.amountAtomic) <= MAX_UINT256) &&
      (row.decimals === null && row.precision === "unknown" || Number.isInteger(row.decimals) && row.decimals! >= 0 && row.decimals! <= 255 && row.precision !== "unknown") &&
      (row.asset.kind !== "native" || row.decimals === 18 && row.precision === "verified"),
    "PRICE_INPUT_INVALID", "Invalid portfolio asset.");
    identities.add(request.assetId);
    return [{ row, request, quote: null as GeneralPriceQuote | null }];
  });
  const eligible = plan.filter(({ row }) => row.amountAtomic !== null && row.decimals !== null && (row.status === "fresh" || row.status === "stale"));
  for (let offset = 0; offset < eligible.length; offset += 20) {
    current();
    if (!input.prices) break;
    const batch = eligible.slice(offset, offset + 20);
    let quotes: Array<GeneralPriceQuote | null>;
    try { quotes = await input.prices.read(batch.map(({ row }) => ({ networkId: row.networkId, asset: row.asset })), signal); }
    catch { current(); continue; }
    current();
    requireWallet(Array.isArray(quotes) && quotes.length === batch.length, "PRICE_INPUT_INVALID", "Price results do not match the view.");
    for (let index = 0; index < batch.length; index++) {
      const item = batch[index]!, quote = quotes[index];
      requireWallet(quote && quote.assetId === item.request.assetId && quote.currency === "USD" && quote.provider === "coingecko" &&
        (quote.status === "unavailable" && quote.priceDecimal === null && quote.providerTimestamp === null && quote.fetchedAt === null ||
          (quote.status === "fresh" || quote.status === "stale") && typeof quote.priceDecimal === "string" &&
          Number.isSafeInteger(quote.providerTimestamp) && quote.providerTimestamp! >= 0 && Number.isSafeInteger(quote.fetchedAt) && quote.fetchedAt! >= 0),
      "PRICE_INPUT_INVALID", "Price results do not match the view.");
      item.quote = structuredClone(quote);
    }
  }
  current();
  const total = generalUsdEstimate(plan.map(({ row, request, quote }) => ({ assetId: request.assetId, testnet: false,
    decimals: row.decimals ?? 0, amountAtomic: row.amountAtomic, balanceStatus: row.decimals === null ? "unsupported" : row.status,
    priceDecimal: quote?.priceDecimal ?? null, priceStatus: quote?.status ?? "unavailable" })));
  const observed = plan.flatMap(({ row }) => (row.status === "fresh" || row.status === "stale") && row.observedAt !== null ? [row.observedAt] : []);
  const incomplete = coverage.some((item) => item.status === "error" || !plan.some(({ row }) => row.networkId === item.networkId));
  return { view, rows: plan.map(({ row, request, quote }, index) => ({ ...row, assetId: request.assetId, quote,
    usdCents: total.items[index]!.cents, stale: total.items[index]!.stale, precisionUnverified: row.precision === "user" })),
    observedFrom: observed.length ? Math.min(...observed) : null, observedTo: observed.length ? Math.max(...observed) : null,
    networkCoverage: coverage, knownTotalCents: total.knownTotalCents, partial: total.partial || incomplete,
    stale: total.stale || coverage.some((item) => item.status === "stale") };
}
