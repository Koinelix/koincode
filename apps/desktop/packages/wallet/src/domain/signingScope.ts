import type { ExactAuthorization, PaymentScope } from "./model.js";
import { requireWallet } from "./errors.js";
export function sameAuthorization(
  a: Readonly<ExactAuthorization>,
  b: Readonly<ExactAuthorization>,
): boolean {
  return (
    JSON.stringify(a.upto ?? null) === JSON.stringify(b.upto ?? null) &&
    a.network === b.network &&
    a.asset === b.asset &&
    a.payer === b.payer &&
    a.payTo === b.payTo &&
    a.amountAtomic === b.amountAtomic &&
    a.nonce === b.nonce &&
    a.validAfter === b.validAfter &&
    a.validBefore === b.validBefore
  );
}
export function scopeInput(scope: PaymentScope): void {
  requireWallet(
    Object.keys(scope).sort().join() ===
      [
        ...(scope.scheme === undefined ? [] : ["scheme"]),
        "subjectId",
        "requestId",
        "requestDigest",
        "quoteDigest",
        "credentialVersion",
        "origin",
        "path",
        "method",
        "network",
        "asset",
        "payTo",
        "amountAtomic",
      ]
        .sort()
        .join() &&
      (scope.scheme === undefined || scope.scheme === "exact" || scope.scheme === "upto") &&
      [scope.subjectId, scope.requestId, scope.requestDigest, scope.quoteDigest].every(
        (value) => typeof value === "string" && value.length > 0 && value.length <= 256,
      ) &&
      (scope.credentialVersion === null ||
        (typeof scope.credentialVersion === "string" && scope.credentialVersion.length <= 256)) &&
      typeof scope.origin === "string" &&
      typeof scope.path === "string" &&
      typeof scope.method === "string" &&
      typeof scope.asset === "string" &&
      typeof scope.payTo === "string",
    "PERMIT_MISMATCH",
    "The frozen purchase identity is invalid.",
  );
}
