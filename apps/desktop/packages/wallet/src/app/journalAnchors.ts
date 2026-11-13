import type { JournalCheckpoint } from "../domain/operationJournal.js";
import { OPERATION_JOURNAL_LIMIT } from "../domain/operationJournal.js";
import { requireWallet } from "../domain/errors.js";
import type { RuntimeContext } from "./runtimeContext.js";
import type { ClientHandle } from "./sessions.js";
import { operationHistory } from "./transportState.js";
import { requestDigest } from "./requestFacts.js";
import { consumeJournalInitialization } from "./journalInitialization.js";

const hash = /^[0-9a-f]{64}$/;
const empty = requestDigest([]);

/** The existing protected wallet owner serializes namespace registration and digest CAS. */
export class WalletJournalAnchors {
  constructor(private readonly ctx: RuntimeContext) {}
  async commit(handle: ClientHandle, checkpoint: JournalCheckpoint): Promise<void> {
    const { initialization, ...data } = checkpoint;
    const c = structuredClone(data);
    requireWallet(c && hash.test(c.binding) &&
      [c.before, c.after].every(d => d && Number.isSafeInteger(d.count) && d.count >= 0 &&
        d.count <= OPERATION_JOURNAL_LIMIT && hash.test(d.digest)) &&
      (c.after.count === c.before.count
        ? c.after.digest === c.before.digest
        : c.after.count === c.before.count + 1),
    "OPERATION_HISTORY_INCOMPLETE", "The operation journal checkpoint is invalid.");
    await this.ctx.state.mutate(state => {
      requireWallet(!this.ctx.fence.signal.aborted, "WALLET_CLOSED", "The wallet is closed.");
      const context = this.ctx.sessions.resolve(handle, state);
      requireWallet(c.clientId === context.clientId, "OPERATION_HISTORY_INCOMPLETE",
        "The operation journal belongs to a different client.");
      const t = operationHistory(state, context.clientId);
      const previous = t.journalAnchors?.find(a => a.clientId === context.clientId);
      if (previous) {
        requireWallet(previous.ownerId === context.ownerId && previous.epoch === state.managementEpoch &&
          previous.binding === c.binding && previous.count === c.before.count &&
          previous.digest === c.before.digest,
        "OPERATION_HISTORY_INCOMPLETE", "The operation journal no longer matches protected history.");
        previous.count = c.after.count;
        previous.digest = c.after.digest;
      } else {
        requireWallet(c.before.count === 0 && c.before.digest === empty &&
          c.after.count === 1 && !t.requests.some(r => r.clientId === context.clientId),
        "OPERATION_HISTORY_INCOMPLETE", "The client requires explicit fresh operation history.");
        consumeJournalInitialization(initialization, context.clientId, c.binding);
        (t.journalAnchors ??= []).push({ version: 1, ownerId: context.ownerId,
          clientId: context.clientId, epoch: state.managementEpoch, binding: c.binding, ...c.after });
      }
    });
  }
}
