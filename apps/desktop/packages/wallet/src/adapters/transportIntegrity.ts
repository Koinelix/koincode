import type { TransportState } from "../domain/requestModel.js";
import { canonical } from "./canonical.js";
import { requireWallet } from "../domain/errors.js";
export function validateTransportTransition(
  before: TransportState | undefined,
  after: TransportState | undefined,
  owner: string,
): void {
  if (!before && !after) return;
  requireWallet(after?.version === 1, "STATE_CONFLICT", "Transport history cannot be removed.");
  const ids = new Set<string>();
  const requests = new Set<string>();
  for (const r of after.requests) {
    const key = JSON.stringify([r.ownerId, r.clientId, r.operationId]);
    requireWallet(
      r.ownerId === owner && !ids.has(key) && !requests.has(r.requestId),
      "STATE_CONFLICT",
      "Operation identities must be unique and owned.",
    );
    ids.add(key);
    requests.add(r.requestId);
    const old = before?.requests.find((x) => x.requestId === r.requestId);
    if (old) {
      const fields = [
        "modelPayment",
        "ownerId",
        "clientId",
        "operationId",
        "inputDigest",
        "frozenRef",
        "frozenDigest",
        "sessionId",
        "generation",
        "epoch",
        "parentRequestId",
        "replayPolicyDigest",
        "action",
        "createdAt",
        "expiresAt",
      ] as const;
      requireWallet(
        fields.every((key) => r[key] === old[key]) &&
          canonical(r.hostActivity ?? null) === canonical(old.hostActivity ?? null) &&
          r.replacementCount >= old.replacementCount &&
          r.replacementCount <= 1 &&
          (!old.canceled || r.canceled),
        "STATE_CONFLICT",
        "A frozen operation cannot be rebound or replayed.",
      );
      requireWallet(
        !old.unsignedRefreshConsumedBy ||
          r.unsignedRefreshConsumedBy === old.unsignedRefreshConsumedBy,
        "STATE_CONFLICT",
        "A consumed unsigned refresh tombstone cannot be cleared or rebound.",
      );
    }
  }
  for (const old of before?.requests ?? [])
    requireWallet(
      requests.has(old.requestId),
      "STATE_CONFLICT",
      "Operation tombstones cannot be removed.",
    );
  for (const [items, key] of [
    [after.credentials, "ref"],
    [after.tokens, "clientId"],
    [after.bodies, "ref"],
  ] as const) {
    const keys = items.map((x) => (x as unknown as Record<string, string>)[key]);
    requireWallet(
      new Set(keys).size === keys.length,
      "STATE_CONFLICT",
      "Transport metadata identities must be unique.",
    );
  }
  for (const old of before?.credentials ?? []) {
    const current = after.credentials.find((x) => x.ref === old.ref);
    requireWallet(
      current &&
        current.ownerId === old.ownerId &&
        current.version >= old.version &&
        (canonical(current) === canonical(old) || current.version > old.version),
      "STATE_CONFLICT",
      "Credential changes require a newer version.",
    );
  }
}
