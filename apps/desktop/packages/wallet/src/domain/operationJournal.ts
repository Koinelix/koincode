export const OPERATION_JOURNAL_LIMIT = 100000;
export const OPERATION_SOURCE_LIMIT = 256;
export interface JournalDigest { count: number; digest: string }
export interface OperationJournalAnchor extends JournalDigest {
  version: 1;
  ownerId: string;
  clientId: string;
  epoch: string;
  binding: string;
}
export interface JournalCheckpoint {
  clientId: string;
  binding: string;
  initialization?: JournalInitializationTicket;
  before: JournalDigest;
  after: JournalDigest;
}
declare const journalInitializationBrand: unique symbol;
export type JournalInitializationTicket = { readonly [journalInitializationBrand]: true };
/** Internal host adapter port; never accept checkpoints from model or MCP input. */
export interface JournalCommitter {
  commit(checkpoint: JournalCheckpoint): Promise<void>;
}
