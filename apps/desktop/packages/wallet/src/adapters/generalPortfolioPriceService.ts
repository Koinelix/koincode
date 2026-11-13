import type { GeneralBalanceAsset } from "../app/generalBalances.js";
import { requireWallet } from "../domain/errors.js";
import { generalPriceRequest } from "./generalPriceIdentity.js";
import { GeneralPriceService, type GeneralPriceQuote, type GeneralPriceRequest } from "./generalPriceService.js";

/** Display-only bridge: the caller supplies tracked asset identities, never provider IDs or account addresses. */
export class GeneralPortfolioPriceService {
  private readonly prices: GeneralPriceService;
  constructor(config: { mode: "demo" | "pro"; apiKey: string }, transport: typeof fetch = fetch, now: () => number = Date.now) {
    this.prices = new GeneralPriceService(config, transport, now);
  }

  async read(assets: readonly { networkId: string; asset: GeneralBalanceAsset }[], signal?: AbortSignal): Promise<Array<GeneralPriceQuote | null>> {
    requireWallet(Array.isArray(assets) && assets.length <= 20, "PRICE_INPUT_INVALID", "Too many price assets.");
    const plan = assets.map(({ networkId, asset }) => generalPriceRequest(networkId, asset));
    const requests = plan.filter((request): request is GeneralPriceRequest => request !== null);
    if (!requests.length) return plan.map(() => null);
    const values = await this.prices.read(requests, signal);
    let next = 0;
    return plan.map((request) => request ? values[next++]! : null);
  }

  close(): void { this.prices.close(); }
}
