import type { TransportState } from "../domain/requestModel.js";
import { requireWallet } from "../domain/errors.js";

/** Merge authenticated history without restoring execution authority or replacing live facts. */
export function mergeBackupTransport(target: TransportState, source: TransportState): void {
  const conflict = (ok: boolean) => requireWallet(ok, "BACKUP_IDENTITY_CONFLICT",
    "Backup transport history conflicts with current identities or completion evidence.");
  const anchors = new Map((target.journalAnchors ?? []).map(a => [a.clientId, a]));
  for (const saved of source.journalAnchors ?? []) {
    const current = anchors.get(saved.clientId);
    if (current) {
      conflict(current.ownerId === saved.ownerId && current.epoch === saved.epoch &&
        current.binding === saved.binding && (current.count !== saved.count || current.digest === saved.digest));
      if (saved.count > current.count) { current.count = saved.count; current.digest = saved.digest; }
    } else {
      const copy = structuredClone(saved);
      (target.journalAnchors ??= []).push(copy); anchors.set(copy.clientId, copy);
    }
  }
  const requestFields = ["ownerId", "clientId", "operationId", "inputDigest", "frozenRef",
    "frozenDigest", "sessionId", "generation", "epoch", "parentRequestId", "replayPolicyDigest",
    "action", "createdAt", "expiresAt"] as const;
  const requests = new Map(target.requests.map(r => [r.requestId, r]));
  const operations = new Map(target.requests.map(r => [JSON.stringify([r.ownerId, r.clientId,
    r.operationId]), r.requestId]));
  for (const saved of source.requests) {
    const operation = JSON.stringify([saved.ownerId, saved.clientId, saved.operationId]);
    conflict(!operations.has(operation) || operations.get(operation) === saved.requestId);
    const current = requests.get(saved.requestId);
    if (current) conflict(requestFields.every(key => current[key] === saved[key]));
    else {
      const copy = structuredClone(saved);
      target.requests.push(copy);
      requests.set(copy.requestId, copy);
      operations.set(operation, copy.requestId);
    }
  }
  const bindings = ["version", "retentionId", "requestId", "ownerId", "clientId", "epoch",
    "phase", "rawRef", "contextRef", "createdAt", "expiresAt"] as const;
  const evidence = ["rawByteLength", "rawSha256", "contextByteLength", "contextSha256"] as const;
  const rows = new Map((target.retentions ?? []).map(r => [r.retentionId, r]));
  for (const saved of source.retentions ?? []) {
    const current = rows.get(saved.retentionId);
    if (current) {
      conflict(bindings.every(key => current[key] === saved[key]));
      if (current.rawSha256 !== undefined && saved.rawSha256 !== undefined)
        conflict(evidence.every(key => current[key] === saved[key]));
    } else {
      const copy = structuredClone(saved);
      if (copy.state !== "deleted") copy.state = "deleting";
      (target.retentions ??= []).push(copy);
      rows.set(copy.retentionId, copy);
    }
  }
}
