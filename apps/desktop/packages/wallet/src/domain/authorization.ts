import { atomic, positiveAtomic, timestamp } from "./atomic.js";
import { requireWallet } from "./errors.js";
import type { ExactAuthorization, PaymentScope } from "./model.js";
import { networkConfig } from "./networks.js";
const FIELDS = [
  ["from", "address"],
  ["to", "address"],
  ["value", "uint256"],
  ["validAfter", "uint256"],
  ["validBefore", "uint256"],
  ["nonce", "bytes32"],
];
function object(value: unknown): Record<string, unknown> {
  requireWallet(
    value && typeof value === "object" && !Array.isArray(value),
    "PERMIT_MISMATCH",
    "Expected structured authorization data.",
  );
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, names: string[]): void {
  requireWallet(
    Object.keys(value).sort().join() === [...names].sort().join(),
    "PERMIT_MISMATCH",
    "Authorization fields differ from the permitted schema.",
  );
}
function uint(value: unknown): string {
  requireWallet(
    typeof value === "bigint" ||
      typeof value === "string" ||
      (typeof value === "number" && Number.isSafeInteger(value) && value >= 0),
    "PERMIT_MISMATCH",
    "Authorization integers must be exact.",
  );
  const encoded = String(value);
  atomic(encoded);
  return encoded;
}
function address(value: unknown): string {
  requireWallet(
    typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value),
    "PERMIT_MISMATCH",
    "Authorization address is invalid.",
  );
  return value.toLowerCase();
}
export function parseSdkAuthorization(
  input: unknown,
  scope: PaymentScope,
  payer: string,
  trustedNow: number,
): ExactAuthorization {
  timestamp(trustedNow);
  const data = object(input);
  keys(data, ["domain", "types", "primaryType", "message"]);
  requireWallet(
    data.primaryType === "TransferWithAuthorization",
    "UNSUPPORTED_AUTHORIZATION",
    "Only EIP-3009 transfer authorization is supported.",
  );
  const config = networkConfig(scope.network);
  const domain = object(data.domain);
  keys(domain, ["name", "version", "chainId", "verifyingContract"]);
  requireWallet(
    uint(domain.chainId) === String(config.chainId),
    "PAYMENT_NETWORK_MISMATCH",
    "The signing domain differs from the payment network.",
  );
  requireWallet(
    scope.asset.toLowerCase() === config.asset &&
      address(domain.verifyingContract) === config.asset &&
      domain.name === config.domainName &&
      domain.version === config.domainVersion,
    "PERMIT_MISMATCH",
    "The EIP-712 domain does not match the trusted asset.",
  );
  const types = object(data.types);
  keys(types, ["TransferWithAuthorization"]);
  const fields = types.TransferWithAuthorization;
  requireWallet(
    Array.isArray(fields) &&
      fields.length === FIELDS.length &&
      fields.every((field: unknown, index) => {
        const item = object(field);
        keys(item, ["name", "type"]);
        return item.name === FIELDS[index]![0] && item.type === FIELDS[index]![1];
      }),
    "PERMIT_MISMATCH",
    "The authorization type definition changed.",
  );
  const message = object(data.message);
  keys(
    message,
    FIELDS.map((field) => field[0]!),
  );
  const from = address(message.from),
    to = address(message.to),
    amount = uint(message.value);
  requireWallet(
    from === payer.toLowerCase() &&
      to === scope.payTo.toLowerCase() &&
      positiveAtomic(amount) === positiveAtomic(scope.amountAtomic),
    "PERMIT_MISMATCH",
    "Authorization payer, recipient or amount changed.",
  );
  const validAfter = timestamp(Number(uint(message.validAfter))),
    validBefore = timestamp(Number(uint(message.validBefore)));
  requireWallet(
    validAfter <= trustedNow &&
      validBefore > trustedNow + 5 &&
      validBefore <= trustedNow + 120 &&
      validBefore > validAfter,
    "AUTHORIZATION_WINDOW_INVALID",
    "The authorization is outside the permitted short validity window.",
  );
  requireWallet(
    typeof message.nonce === "string" && /^0x[0-9a-fA-F]{64}$/.test(message.nonce),
    "PERMIT_MISMATCH",
    "The authorization nonce is invalid.",
  );
  return {
    network: scope.network,
    asset: config.asset,
    payer: from,
    payTo: to,
    amountAtomic: amount,
    validAfter,
    validBefore,
    nonce: message.nonce.toLowerCase(),
  };
}
