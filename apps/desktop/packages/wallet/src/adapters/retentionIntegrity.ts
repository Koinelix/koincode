import type { WalletState } from "../app/state.js";
import type { ResponseRetentionRecord } from "../domain/responseRetention.js";
import { requireWallet } from "../domain/errors.js";
import { RESPONSE_LIMIT } from "../domain/requestValidation.js";
import { canonical } from "./canonical.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const fields = new Set(["version", "retentionId", "requestId", "ownerId", "clientId", "epoch",
  "phase", "rawRef", "contextRef", "createdAt", "expiresAt", "state", "rawByteLength", "rawSha256",
  "contextByteLength", "contextSha256"]);
const evidence = (r: ResponseRetentionRecord) => ({ rawByteLength: r.rawByteLength,
  rawSha256: r.rawSha256, contextByteLength: r.contextByteLength, contextSha256: r.contextSha256 });
const identity = (r: ResponseRetentionRecord) => {
  const { state: _state, rawByteLength: _rawLength, rawSha256: _rawHash,
    contextByteLength: _contextLength, contextSha256: _contextHash, ...binding } = r;
  return binding;
};

export function validateResponseRetentions(state: WalletState): void {
  const rows = state.transport?.retentions;
  if (rows === undefined) {
    requireWallet(!state.transport?.requests.some(r => r.responseRetentionId !== undefined),
      "LEDGER_CORRUPT", "Published retention history cannot be omitted.");
    return;
  }
  requireWallet(Array.isArray(rows) && rows.length > 0 && rows.length <= 100000,
    "LEDGER_CORRUPT", "The retention inventory is invalid.");
  const requests = new Map(state.transport!.requests.map(r => [r.requestId, r]));
  const ids = new Set<string>(), references = new Set<string>(), active = new Set<string>();
  for (const r of requests.values()) for (const ref of
    [r.frozenRef, r.responseRef, r.quoteRef, r.signedQuoteRef, r.payloadRef]) if (ref) references.add(ref);
  for (const body of state.transport!.bodies) references.add(body.blobRef);
  for (const r of rows) {
    requireWallet(r && typeof r === "object" && !Array.isArray(r) &&
      Object.keys(r).every(key => fields.has(key)) && r.version === 1 &&
      [r.retentionId, r.requestId, r.ownerId, r.clientId, r.epoch, r.rawRef, r.contextRef]
        .every(value => typeof value === "string" && uuid.test(value)),
    "LEDGER_CORRUPT", "The retention binding is invalid.");
    const request = requests.get(r.requestId);
    requireWallet(request && request.ownerId === r.ownerId && request.clientId === r.clientId &&
      request.epoch === r.epoch && state.ownerId === r.ownerId &&
      (r.phase === "initial" || r.phase === "paid") &&
      ["writing", "ready", "deleting", "deleted"].includes(r.state) &&
      Number.isSafeInteger(r.createdAt) && Number.isSafeInteger(r.expiresAt) &&
      r.createdAt >= request.createdAt && r.expiresAt > r.createdAt &&
      r.expiresAt <= request.expiresAt && r.expiresAt - r.createdAt <= 86400000 &&
      !ids.has(r.retentionId) && r.rawRef !== r.contextRef &&
      !references.has(r.rawRef) && !references.has(r.contextRef),
    "LEDGER_CORRUPT", "The retention ownership, lifetime or references are invalid.");
    const parts = Object.values(evidence(r));
    requireWallet(parts.every(value => value === undefined) ||
      (Number.isSafeInteger(r.rawByteLength) && r.rawByteLength! >= 0 && r.rawByteLength! <= RESPONSE_LIMIT &&
        Number.isSafeInteger(r.contextByteLength) && r.contextByteLength! > 0 && r.contextByteLength! <= 1048576 &&
        typeof r.rawSha256 === "string" && hash.test(r.rawSha256) &&
        typeof r.contextSha256 === "string" && hash.test(r.contextSha256)),
    "LEDGER_CORRUPT", "Retention completion evidence is incomplete or invalid.");
    requireWallet((r.state !== "ready" || parts.every(value => value !== undefined)) &&
      (r.state !== "writing" || parts.every(value => value === undefined)),
    "LEDGER_CORRUPT", "The retention phase disagrees with its evidence.");
    ids.add(r.retentionId); references.add(r.rawRef); references.add(r.contextRef);
    if (r.state === "writing" || r.state === "ready") {
      const key = r.requestId + ":" + r.phase;
      requireWallet(!active.has(key), "LEDGER_CORRUPT", "A response phase already owns retained material.");
      active.add(key);
    }
  }
  for (const request of requests.values()) if (request.responseRetentionId !== undefined)
    requireWallet(rows.some(r => r.retentionId === request.responseRetentionId &&
      r.requestId === request.requestId && r.epoch === request.epoch),
    "LEDGER_CORRUPT", "Published responses must bind their own retained history.");
}

export function validateRetentionTransition(previous: WalletState, next: WalletState): void {
  validateResponseRetentions(next);
  const before = new Map((previous.transport?.retentions ?? []).map(r => [r.retentionId, r]));
  const after = new Map((next.transport?.retentions ?? []).map(r => [r.retentionId, r]));
  const transitions = { writing: ["writing", "ready", "deleting"], ready: ["ready", "deleting"],
    deleting: ["deleting", "deleted"], deleted: ["deleted"] };
  for (const [id, old] of before) {
    const current = after.get(id);
    requireWallet(current && canonical(identity(old)) === canonical(identity(current)) &&
      transitions[old.state].includes(current.state) &&
      ((old.state === "writing" && current.state === "ready") ||
        canonical(evidence(old)) === canonical(evidence(current))),
    "LEDGER_CORRUPT", "Retention identities and deletion tombstones cannot be rewritten.");
  }
  for (const [id, current] of after) if (!before.has(id)) requireWallet(
    (current.state === "writing" && current.epoch === next.managementEpoch) ||
    (previous.managementEpoch !== next.managementEpoch &&
      (current.state === "deleting" || current.state === "deleted")),
    "LEDGER_CORRUPT", "New retention records require a write intent or invalidated backup history.");
}
