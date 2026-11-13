import type { StoredQuote } from "../domain/requestModel.js";
import { requireWallet, WalletError } from "../domain/errors.js";
import { positiveAtomic } from "../domain/atomic.js";
import { requestDigest } from "./requestFacts.js";
import { networkConfig } from "../domain/networks.js";
import { assertDiscoveryExtensions } from "./requestExtensions.js";
export function parseQuote(
  header: string | undefined,
  url: string,
  wall: number,
  monotonic: number,
  clockId: string,
  covers?: (quote: StoredQuote) => boolean,
  network: import("../domain/model.js").Network = "eip155:84532",
): StoredQuote {
  requireWallet(
    header &&
      header.length <= 32768 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(header) &&
      header.length % 4 === 0,
    "X402_INVALID_CHALLENGE",
    "A bounded v2 payment challenge is required.",
  );
  let challenge: Record<string, unknown>;
  try {
    challenge = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    throw new WalletError("X402_INVALID_CHALLENGE", "The payment challenge could not be decoded.");
  }
  requireWallet(
    challenge &&
      challenge.x402Version === 2 &&
      challenge.resource &&
      typeof challenge.resource === "object" &&
      typeof (challenge.resource as Record<string, unknown>).url === "string" &&
      Array.isArray(challenge.accepts) &&
      challenge.accepts.length > 0 &&
      challenge.accepts.length <= 16,
    "X402_INVALID_CHALLENGE",
    "The challenge version, resource or options are invalid.",
  );
  assertDiscoveryExtensions(challenge.extensions);
  const config = networkConfig(network);
  const options: StoredQuote[] = [];
  for (const item of challenge.accepts) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>,
      extra = r.extra as Record<string, unknown> | undefined;
    if (
      (r.scheme !== "exact" && r.scheme !== "upto") ||
      r.network !== network ||
      typeof r.asset !== "string" ||
      r.asset.toLowerCase() !== config.asset ||
      !extra ||
      extra.name !== config.domainName ||
      extra.version !== config.domainVersion ||
      (r.scheme === "exact" && extra.assetTransferMethod !== undefined && extra.assetTransferMethod !== "eip3009")
    )
      continue;
    const resource = (challenge.resource as Record<string, unknown>).url;
    const requested = new URL(url);
    requireWallet(resource === (r.scheme === "upto" ? requested.origin + requested.pathname : url),
      "X402_INVALID_CHALLENGE", "The quote resource differs from the requested service.");
    if (r.scheme === "upto") requireWallet(typeof extra.facilitatorAddress === "string" &&
      /^0x[0-9a-f]{40}$/i.test(extra.facilitatorAddress) && !/^0x0{40}$/i.test(extra.facilitatorAddress),
      "X402_INVALID_CHALLENGE", "The upto quote has no valid facilitator.");
    requireWallet(
      typeof r.payTo === "string" &&
        /^0x[0-9a-f]{40}$/i.test(r.payTo) &&
        !/^0x0{40}$/i.test(r.payTo) &&
        Number.isSafeInteger(r.maxTimeoutSeconds) &&
        (r.maxTimeoutSeconds as number) > 0 &&
        (r.maxTimeoutSeconds as number) <= (r.scheme === "upto" ? 900 : 120) &&
        (r.scheme !== "upto" || (r.maxTimeoutSeconds as number) >= 180),
      "X402_INVALID_CHALLENGE",
      "Payment amount, recipient or timeout is invalid.",
    );
    positiveAtomic(r.amount as string);
    const selected = structuredClone(r) as unknown as StoredQuote["selected"];
    options.push({
      challenge,
      selected,
      receivedAt: wall,
      receivedMonotonic: monotonic,
      clockId,
      digest: requestDigest({ resource: challenge.resource, selected }),
    });
  }
  if (options.length) return options.find((quote) => covers?.(quote)) ?? options[0]!;
  if (challenge.accepts.some((item: unknown) => item && typeof item === "object" &&
    ["exact", "upto"].includes((item as Record<string, unknown>).scheme as string) &&
    (item as Record<string, unknown>).network !== network))
    throw new WalletError("PAYMENT_NETWORK_MISMATCH", "The quotation requires another payment network.");
  throw new WalletError(
    "X402_UNSUPPORTED_PAYMENT",
    "No supported payment option on the fixed network was offered.",
  );
}
