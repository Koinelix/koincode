import { WalletError, requireWallet } from "../domain/errors.js";

export type GeneralSnapshotLease = { isCurrent(): boolean; release(): void };

/** Queue ownership stays on the same journal instance; a snapshot never waits behind pending work. */
export abstract class GeneralSnapshotQueue {
  protected queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private snapshot?: object;
  protected abstract assertAvailable(): void;

  reserveBackupSnapshot(): GeneralSnapshotLease {
    this.assertAvailable();
    requireWallet(!this.snapshot && this.pending === 0, "GENERAL_OPERATION_BUSY", "The signing journal is busy.");
    const token = Object.freeze({}); this.snapshot = token;
    return { isCurrent: () => { try { this.assertAvailable(); return this.snapshot === token; } catch { return false; } },
      release: () => { if (this.snapshot === token) this.snapshot = undefined; } };
  }

  protected exclusive<T>(work: () => Promise<T>, snapshotRead = false): Promise<T> {
    if (this.snapshot && !snapshotRead) return Promise.reject(new WalletError("GENERAL_OPERATION_BUSY", "A general wallet backup snapshot is active."));
    this.pending++;
    const operation = this.queue.then(async () => { this.assertAvailable(); return await work(); })
      .finally(() => { this.pending--; });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
