import { randomUUID } from "node:crypto";
import { positiveAtomic, timestamp } from "../domain/atomic.js";
import { requireWallet } from "../domain/errors.js";
import type { PaymentGrant } from "../domain/model.js";
import type { GrantInput } from "./runtimeTypes.js";
import type { WalletState } from "./state.js";
import { audit, walletRecord, type RuntimeContext } from "./runtimeContext.js";

function validateGrant(input: GrantInput): void {
  const target = new URL(input.origin);
  requireWallet(
    target.origin === input.origin &&
      !target.username &&
      !target.password &&
      (target.protocol === "https:" ||
        (target.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))) &&
      input.path.startsWith("/") &&
      input.path.length <= 4096 &&
      !input.path.includes("#") &&
      /^[A-Z]{1,16}$/.test(input.method) &&
      /^0x[0-9a-f]{40}$/i.test(input.payTo) &&
      ["once", "session", "persistent"].includes(input.scope) &&
      typeof input.pathPrefix === "boolean" &&
      input.clientIds.length > 0 &&
      input.clientIds.length <= 128 &&
      new Set(input.clientIds).size === input.clientIds.length,
    "GRANT_INVALID",
    "The trusted grant configuration is invalid.",
  );
  positiveAtomic(input.maxAmountAtomic);
}
/** Shared synchronous grant reducer. Its caller owns the control fence and protected transaction. */
export function createGrantInState(
  ctx: RuntimeContext,
  state: WalletState,
  input: GrantInput,
  now: number,
  sessionCredentialVersion?: string,
): string {
  validateGrant(input);
  if (input.expiresAt !== null)
    requireWallet(timestamp(input.expiresAt) > now, "GRANT_EXPIRED", "The grant has expired.");
  if (input.scope === "once")
    requireWallet(
      input.purchase &&
        input.expiresAt !== null &&
        input.expiresAt <= now + 120 &&
        !input.pathPrefix,
      "GRANT_INVALID",
      "A once grant requires an exact live purchase and expiry.",
    );
  const wallet = walletRecord(state, input.walletId);
  requireWallet(
    input.clientIds.every((id) =>
      state.clients.some(
        (client) =>
          client.clientId === id && client.active && client.subjectIds.includes(wallet.subjectId),
      ),
    ),
    "GRANT_SCOPE_MISMATCH",
    "The client cannot access this wallet.",
  );
  const context =
    input.scope === "session" && input.connection
      ? ctx.sessions.requireSubject(input.connection, wallet.subjectId, state)
      : null;
  requireWallet(
    input.scope !== "session" ||
      (context && input.clientIds.length === 1 && input.clientIds[0] === context.clientId),
    "GRANT_INVALID",
    "A session grant requires its authenticated connection.",
  );
  if (input.scope === "once")
    for (const value of Object.values(input.purchase!))
      requireWallet(
        typeof value === "string" && value.length > 0 && value.length <= 256,
        "GRANT_INVALID",
        "The frozen purchase identity is invalid.",
      );
  const hostScope = input.scope === "session" && sessionCredentialVersion !== undefined && input.connection
    ? ctx.sessions.hostGrantScope(input.connection) : undefined;
  if (input.scope === "session" && sessionCredentialVersion?.startsWith("host:"))
    requireWallet(typeof hostScope === "string" && /^[0-9a-f]{64}$/.test(hostScope),
      "GRANT_INVALID", "The trusted host grant scope is unavailable.");
  const grant: PaymentGrant = {
    grantId: randomUUID(),
    subjectId: wallet.subjectId,
    ownerId: state.ownerId,
    clientIds: [...input.clientIds],
    scope: input.scope,
    sessionId: context?.sessionId ?? null,
    generation: context?.generation ?? null,
    requestId: input.scope === "once" ? input.purchase!.requestId : null,
    requestDigest: input.scope === "once" ? input.purchase!.requestDigest : null,
    quoteDigest: input.scope === "once" ? input.purchase!.quoteDigest : null,
    ...(input.scope === "session" && sessionCredentialVersion !== undefined ? { sessionCredentialVersion } : {}),
    ...(hostScope === undefined ? {} : { sessionHostScope: hostScope }),
    origin: input.origin,
    path: input.path,
    pathPrefix: input.pathPrefix,
    method: input.method,
    network: wallet.network,
    asset: wallet.asset,
    payTo: input.payTo.toLowerCase(),
    maxAmountAtomic: input.maxAmountAtomic,
    expiresAt: input.expiresAt,
    managementEpoch: state.managementEpoch,
    version: 1,
    status: "active",
  };
  state.grants.push(grant);
  state.trustedTime = Math.max(state.trustedTime, now);
  audit(state, "GRANT_CREATED", wallet.subjectId, {
    grantId: grant.grantId,
    scope: grant.scope,
  });
  return grant.grantId;
}
