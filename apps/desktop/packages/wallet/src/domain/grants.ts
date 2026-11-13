import { positiveAtomic, timestamp } from "./atomic.js";
import { requireWallet } from "./errors.js";
import type { ClientContext, PaymentGrant, PaymentScope } from "./model.js";

export function checkGrant(
  grant: PaymentGrant,
  scope: PaymentScope,
  client: ClientContext,
  epoch: string,
  now: number,
  hostGrantScope?: string,
): void {
  timestamp(now);
  requireWallet(
    grant.status === "active" && grant.managementEpoch === epoch,
    "GRANT_INVALID",
    "The grant is not active in this management epoch.",
  );
  requireWallet(
    grant.ownerId === client.ownerId && grant.clientIds.includes(client.clientId),
    "GRANT_SCOPE_MISMATCH",
    "The client is outside this grant.",
  );
  requireWallet(
    grant.expiresAt === null || timestamp(grant.expiresAt) > now,
    "GRANT_EXPIRED",
    "The grant has expired.",
  );
  requireWallet(
    grant.subjectId === scope.subjectId &&
      grant.network === scope.network &&
      grant.asset.toLowerCase() === scope.asset.toLowerCase() &&
      grant.payTo.toLowerCase() === scope.payTo.toLowerCase(),
    "GRANT_SCOPE_MISMATCH",
    "Payment identity differs from the grant.",
  );
  const pathMatches = grant.pathPrefix
    ? scope.path === grant.path ||
      scope.path.startsWith(grant.path.endsWith("/") ? grant.path : grant.path + "/")
    : scope.path === grant.path;
  requireWallet(
    grant.origin === scope.origin && grant.method === scope.method && pathMatches,
    "GRANT_SCOPE_MISMATCH",
    "The request target is outside this grant.",
  );
  requireWallet(
    positiveAtomic(scope.amountAtomic) <= positiveAtomic(grant.maxAmountAtomic),
    "GRANT_AMOUNT_EXCEEDED",
    "The grant amount would be exceeded.",
  );
  if (grant.scope === "once") {
    requireWallet(
      grant.requestId === scope.requestId &&
        grant.requestDigest === scope.requestDigest &&
        grant.quoteDigest === scope.quoteDigest,
      "GRANT_SCOPE_MISMATCH",
      "The one-time grant belongs to a different frozen purchase.",
    );
  }
  if (grant.scope === "session") {
    requireWallet(
      grant.sessionId === client.sessionId && grant.generation === client.generation,
      "GRANT_SCOPE_MISMATCH",
      "The session grant does not match this connection.",
    );
    if (scope.credentialVersion?.startsWith("host:")) {
      requireWallet(grant.sessionCredentialVersion === scope.credentialVersion,
        "GRANT_SCOPE_MISMATCH", "The host credential differs from this session grant.");
      requireWallet(typeof grant.sessionHostScope === "string" && /^[0-9a-f]{64}$/.test(grant.sessionHostScope) &&
        typeof hostGrantScope === "string" && /^[0-9a-f]{64}$/.test(hostGrantScope) && grant.sessionHostScope === hostGrantScope,
        "GRANT_SCOPE_MISMATCH", "The host session scope differs from this session grant.");
    }
  }
}
