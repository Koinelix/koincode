import type { WalletState } from "../app/state.js";
import { OPERATION_JOURNAL_LIMIT } from "../domain/operationJournal.js";
import { requireWallet } from "../domain/errors.js";

const hash = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fields = ["version", "ownerId", "clientId", "epoch", "binding", "count", "digest"].sort().join();
export function validateJournalAnchors(state: WalletState): void {
  const anchors = state.transport?.journalAnchors;
  if (anchors === undefined) return;
  requireWallet(Array.isArray(anchors) && anchors.length > 0 && anchors.length <= OPERATION_JOURNAL_LIMIT,
    "LEDGER_CORRUPT", "The operation journal inventory is invalid.");
  const clients = new Set<string>();
  for (const a of anchors) {
    requireWallet(a && typeof a === "object" && !Array.isArray(a) &&
      Object.keys(a).sort().join() === fields && a.version === 1 && a.ownerId === state.ownerId &&
      uuid.test(a.clientId) && uuid.test(a.epoch) && hash.test(a.binding) && hash.test(a.digest) &&
      Number.isSafeInteger(a.count) && a.count > 0 && a.count <= OPERATION_JOURNAL_LIMIT && !clients.has(a.clientId),
    "LEDGER_CORRUPT", "An operation journal anchor is invalid.");
    clients.add(a.clientId);
  }
}
export function validateJournalTransition(previous: WalletState, next: WalletState): void {
  validateJournalAnchors(next);
  const anchors = new Map((next.transport?.journalAnchors ?? []).map(a => [a.clientId, a]));
  for (const old of previous.transport?.journalAnchors ?? []) {
    const current = anchors.get(old.clientId);
    requireWallet(current && current.ownerId === old.ownerId && current.epoch === old.epoch &&
      current.binding === old.binding && current.count >= old.count &&
      (current.count !== old.count || current.digest === old.digest),
    "STATE_CONFLICT", "Operation journal commitments cannot be removed, rebound or rolled back.");
  }
}
