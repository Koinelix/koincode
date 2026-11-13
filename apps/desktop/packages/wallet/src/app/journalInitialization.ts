import type { JournalInitializationTicket } from "../domain/operationJournal.js";
import { requireWallet } from "../domain/errors.js";

const tickets = new WeakMap<JournalInitializationTicket, { clientId: string; binding: string }>();

/** Internal adapter authority, never exported by the package or serialized across IPC. */
export function issueJournalInitialization(clientId: string, binding: string): JournalInitializationTicket {
  const ticket = Object.freeze({}) as JournalInitializationTicket;
  tickets.set(ticket, { clientId, binding });
  return ticket;
}

export function consumeJournalInitialization(ticket: JournalInitializationTicket | undefined,
  clientId: string, binding: string): void {
  const facts = ticket && tickets.get(ticket);
  requireWallet(facts && facts.clientId === clientId && facts.binding === binding,
    "OPERATION_HISTORY_INCOMPLETE", "A fresh host journal initialization capability is required.");
  tickets.delete(ticket!);
}
