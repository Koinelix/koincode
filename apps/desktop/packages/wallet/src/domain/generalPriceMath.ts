import { requireWallet } from "./errors.js";

const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_ITEMS = 200;
const ATOMIC = /^(0|[1-9][0-9]{0,77})$/;
const DECIMAL = /^(0|[1-9][0-9]{0,35})(?:\.([0-9]{1,36}))?$/;

export type GeneralValueInput = {
  assetId: string;
  testnet: boolean;
  decimals: number;
  amountAtomic: string | null;
  balanceStatus: "fresh" | "stale" | "error" | "unsupported" | "metadata_conflict";
  priceDecimal: string | null;
  priceStatus: "fresh" | "stale" | "error" | "unavailable";
};

type ExactValue = { assetId: string; numerator: bigint; scale: number; stale: boolean };
function cents(numerator: bigint, scale: number): string {
  if (scale <= 2) return (numerator * 10n ** BigInt(2 - scale)).toString();
  const divisor = 10n ** BigInt(scale - 2);
  return ((numerator + divisor / 2n) / divisor).toString();
}

/** Display-only USD estimates. Inputs must already be mapped to trusted asset and price identities. */
export function generalUsdEstimate(inputs: readonly GeneralValueInput[]): {
  items: { assetId: string; cents: string | null; stale: boolean; excluded: boolean }[];
  knownTotalCents: string | null;
  partial: boolean;
  stale: boolean;
} {
  requireWallet(Array.isArray(inputs) && inputs.length <= MAX_ITEMS, "INVALID_PRICE_INPUT", "Invalid valuation input.");
  const ids = new Set<string>(), values: ExactValue[] = [];
  let partial = false;
  const items = inputs.map((input) => {
    requireWallet(input && typeof input.assetId === "string" && input.assetId.length > 0 && input.assetId.length <= 256 &&
      !ids.has(input.assetId) && typeof input.testnet === "boolean" && Number.isInteger(input.decimals) &&
      input.decimals >= 0 && input.decimals <= 255 &&
      ["fresh", "stale", "error", "unsupported", "metadata_conflict"].includes(input.balanceStatus) &&
      ["fresh", "stale", "error", "unavailable"].includes(input.priceStatus), "INVALID_PRICE_INPUT", "Invalid valuation input.");
    ids.add(input.assetId);
    if (input.testnet) return { assetId: input.assetId, cents: null, stale: false, excluded: true };
    if (input.balanceStatus !== "fresh" && input.balanceStatus !== "stale" ||
        input.priceStatus !== "fresh" && input.priceStatus !== "stale" || input.amountAtomic === null || input.priceDecimal === null) {
      partial = true;
      return { assetId: input.assetId, cents: null, stale: false, excluded: false };
    }
    requireWallet(typeof input.amountAtomic === "string" && ATOMIC.test(input.amountAtomic) && BigInt(input.amountAtomic) <= MAX_UINT256 &&
      typeof input.priceDecimal === "string", "INVALID_PRICE_INPUT", "Invalid valuation input.");
    const match = DECIMAL.exec(input.priceDecimal);
    requireWallet(match, "INVALID_PRICE_INPUT", "Invalid valuation input.");
    const fractional = match[2] ?? "", price = BigInt(match[1]! + fractional);
    const exact: ExactValue = { assetId: input.assetId, numerator: BigInt(input.amountAtomic) * price,
      scale: input.decimals + fractional.length, stale: input.balanceStatus === "stale" || input.priceStatus === "stale" };
    values.push(exact);
    return { assetId: input.assetId, cents: cents(exact.numerator, exact.scale), stale: exact.stale, excluded: false };
  });
  if (!values.length) return { items, knownTotalCents: null, partial, stale: false };
  const scale = Math.max(...values.map((value) => value.scale));
  const total = values.reduce((sum, value) => sum + value.numerator * 10n ** BigInt(scale - value.scale), 0n);
  return { items, knownTotalCents: cents(total, scale), partial, stale: values.some((value) => value.stale) };
}
