import { validateTransportTransition } from "./transportIntegrity.js";
import { canonical } from "./canonical.js";
import type { WalletState } from "../app/state.js";
import { requireWallet } from "../domain/errors.js";
import { validateGeneralPaymentSourceTransition } from "./generalPaymentSourceRepository.js";
const EVM_FIELDS = new Set(["address", "asset", "payTo", "nonce", "baselineHash", "anchorHash"]);
function identity(value: unknown, field: string): unknown {
  if (field === "upto") return canonical(value ?? null);
  return EVM_FIELDS.has(field) && typeof value === "string" ? value.toLowerCase() : value;
}
function stable<T extends object>(
  before: readonly T[],
  after: readonly T[],
  id: keyof T,
  fields: (keyof T)[],
): void {
  const indexed = new Map(after.map((record) => [record[id], record]));
  requireWallet(
    indexed.size === after.length,
    "STATE_CONFLICT",
    "Wallet record identities must be unique.",
  );
  for (const original of before) {
    const current = indexed.get(original[id]);
    requireWallet(
      current &&
        fields.every(
          (field) =>
            identity(current[field], String(field)) === identity(original[field], String(field)),
        ),
      "STATE_CONFLICT",
      "An existing wallet identity cannot be removed or rebound.",
    );
  }
}
export function validateStateTransition(previous: WalletState, next: WalletState): void {
  validateGeneralPaymentSourceTransition(previous, next);
  validateTransportTransition(previous.transport, next.transport, next.ownerId);
  requireWallet(
    next.installationId === previous.installationId &&
      next.ownerId === previous.ownerId &&
      next.initializationAttempt === previous.initializationAttempt &&
      next.revision === previous.revision + 1 &&
      Number.isSafeInteger(next.revision) &&
      Number.isSafeInteger(next.trustedTime) &&
      next.trustedTime >= previous.trustedTime,
    "STATE_CONFLICT",
    "Wallet state continuity failed.",
  );
  stable(previous.wallets, next.wallets, "walletId", [
    "subjectId",
    "address",
    "network",
    "asset",
    "baselineBlock",
    "baselineHash",
  ]);
  stable(previous.subjects, next.subjects, "subjectId", ["ownerId", "address", "network", "asset"]);
  stable(previous.clients, next.clients, "clientId", ["ownerId", "registrationEpoch"]);
  for (const original of previous.clients)
    if (original.peerIdentityKey)
      requireWallet(
        next.clients.find((client) => client.clientId === original.clientId)?.peerIdentityKey ===
          original.peerIdentityKey,
        "STATE_CONFLICT",
        "A bound client code identity requires a new registration to change.",
      );
  stable(previous.observations, next.observations, "observationId", [
    "intentId",
    "network",
    "txHash",
    "logIndex",
  ]);
  stable(previous.recoveries, next.recoveries, "recoveryId", [
    "subjectId",
    "sourceInstallationId",
    "sourceOwnerId",
    "sourceHistory",
    "baselineBlock",
    "baselineHash",
    "startedAt",
    "riskExpiresAfter",
  ]);
  stable(previous.grants, next.grants, "grantId", ["ownerId", "subjectId"]);
  stable(previous.permits, next.permits, "permitId", ["intentId", "requestId", "expiresAt"]);
  stable(previous.intents, next.intents, "intentId", [
    "scheme", "upto",
    "subjectId",
    "replacesIntentId",
    "authorizedTimeoutSeconds",
    "requestId",
    "walletId",
    "clientId",
    "sessionId",
    "generation",
    "grantId",
    "grantVersion",
    "policyVersion",
    "managementEpoch",
    "nonce",
    "validAfter",
    "validBefore",
    "anchorBlock",
    "anchorHash",
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
  ]);
  const retainedSessions = previous.sessions.filter((session) =>
    next.sessions.some((current) => current.sessionId === session.sessionId),
  );
  stable(retainedSessions, next.sessions, "sessionId", [
    "ownerId",
    "clientId",
    "generation",
    "identityLevel",
  ]);
  for (const client of next.clients) {
    const old = previous.clients.find((record) => record.clientId === client.clientId);
    requireWallet(
      Number.isSafeInteger(client.generation) && client.generation >= (old?.generation ?? 0),
      "STATE_CONFLICT",
      "Client generations cannot move backward.",
    );
  }
  for (const [id, policy] of Object.entries(previous.policies)) {
    const current = next.policies[id];
    requireWallet(
      current &&
        current.version >= policy.version &&
        (canonical(current) === canonical(policy) || current.version > policy.version),
      "STATE_CONFLICT",
      "Policy changes require a newer version.",
    );
  }
  for (const grant of previous.grants) {
    const current = next.grants.find((record) => record.grantId === grant.grantId)!;
    const comparable = { ...current, status: grant.status };
    const consumedOnly =
      current.status === "consumed" && canonical(comparable) === canonical(grant);
    requireWallet(
      current.version >= grant.version &&
        (canonical(current) === canonical(grant) ||
          consumedOnly ||
          current.version > grant.version),
      "STATE_CONFLICT",
      "Grant changes require a newer version.",
    );
  }
  requireWallet(
    next.defaultWalletId === null ||
      next.wallets.some((wallet) => wallet.walletId === next.defaultWalletId),
    "STATE_CONFLICT",
    "The default wallet does not exist.",
  );
  requireWallet(
    next.auditEvents.length >= previous.auditEvents.length &&
      canonical(next.auditEvents.slice(0, previous.auditEvents.length)) ===
        canonical(previous.auditEvents),
    "LEDGER_CORRUPT",
    "Audit events cannot be changed or removed.",
  );
  const subjects = new Set(
    next.subjects.map((subject) =>
      [
        subject.ownerId,
        subject.address.toLowerCase(),
        subject.network,
        subject.asset.toLowerCase(),
      ].join("\0"),
    ),
  );
  const wallets = new Set(
    next.wallets.map((wallet) => [wallet.address.toLowerCase(), wallet.network].join("\0")),
  );
  requireWallet(
    subjects.size === next.subjects.length && wallets.size === next.wallets.length,
    "STATE_CONFLICT",
    "A chain identity cannot create a second budget subject.",
  );
  requireWallet(
    next.subjects.every((subject) => subject.ownerId === next.ownerId) &&
      next.clients.every((client) => client.ownerId === next.ownerId),
    "STATE_CONFLICT",
    "Wallet records must belong to this owner.",
  );
}

const COLUMN_FIELDS: Record<string, Record<string, string>> = {
  recovery_sessions: { recovery_id: "recoveryId", subject_id: "subjectId" },
  settlement_observations: {
    observation_id: "observationId",
    intent_id: "intentId",
    network: "network",
    tx_hash: "txHash",
    log_index: "logIndex",
  },
  audit_events: { event_id: "eventId" },
  wallets: { wallet_id: "walletId", address: "address", network: "network", key_ref: "keyRef" },
  budget_subjects: {
    subject_id: "subjectId",
    owner_id: "ownerId",
    address: "address",
    network: "network",
    asset: "asset",
  },
  wallet_policies: { subject_id: "subjectId", version: "limits.version" },
  client_registrations: { client_id: "clientId", owner_id: "ownerId", generation: "generation" },
  client_sessions: { session_id: "sessionId", client_id: "clientId", generation: "generation" },
  payment_grants: { grant_id: "grantId", subject_id: "subjectId", version: "version" },
  payment_permits: { permit_id: "permitId", request_id: "requestId" },
  payment_intents: {
    intent_id: "intentId",
    subject_id: "subjectId",
    request_id: "requestId",
    status: "status",
  },
};
export function validateDocumentRow(
  table: string,
  row: Record<string, unknown>,
  document: unknown,
): void {
  requireWallet(
    document && typeof document === "object" && !Array.isArray(document),
    "LEDGER_CORRUPT",
    "A wallet record document is invalid.",
  );
  const fields = COLUMN_FIELDS[table];
  requireWallet(fields, "INVALID_TABLE", "Unknown wallet document table.");
  for (const [column, path] of Object.entries(fields)) {
    const value = path
      .split(".")
      .reduce<unknown>(
        (current, key) =>
          current && typeof current === "object"
            ? (current as Record<string, unknown>)[key]
            : undefined,
        document,
      );
    requireWallet(
      row[column] === identity(value, path),
      "LEDGER_CORRUPT",
      "Wallet index columns disagree with their document.",
    );
  }
}

export function validateAuthorizationRows(
  state: WalletState,
  authorizations: Record<string, unknown>[],
  reservations: Record<string, unknown>[],
): void {
  requireWallet(
    authorizations.length === state.intents.length && reservations.length === state.intents.length,
    "LEDGER_CORRUPT",
    "Authorization or reservation records are incomplete.",
  );
  const intents = new Map(state.intents.map((intent) => [intent.intentId, intent]));
  for (const row of authorizations) {
    const intent = intents.get(String(row.intent_id));
    const subject = state.subjects.find((subject) => subject.subjectId === intent?.subjectId);
    requireWallet(intent && subject, "LEDGER_CORRUPT", "Authorization identity is missing.");
    const document = JSON.parse(String(row.document));
    requireWallet(
      row.network === intent.network &&
        row.asset === intent.asset.toLowerCase() &&
        row.payer === subject.address.toLowerCase() &&
        row.nonce === intent.nonce.toLowerCase() &&
        Object.keys(document).length === 4 &&
        document.validAfter === intent.validAfter &&
        document.validBefore === intent.validBefore &&
        document.anchorBlock === intent.anchorBlock &&
        document.anchorHash === intent.anchorHash,
      "LEDGER_CORRUPT",
      "Authorization columns disagree with their bound intent.",
    );
  }
  for (const row of reservations) {
    const intent = intents.get(String(row.intent_id));
    const document = JSON.parse(String(row.document));
    requireWallet(
      intent &&
        row.amount_atomic === (intent.reserved ? intent.amountAtomic : "0") &&
        Object.keys(document).length === 1 &&
        document.active === intent.reserved,
      "LEDGER_CORRUPT",
      "Reservation columns disagree with their bound intent.",
    );
  }
}
