import { WalletError } from "../domain/errors.js";

interface Reader<T> {
  nonces: readonly string[];
  resolve(value: T): void;
  reject(error: unknown): void;
}
interface Batch<T> {
  nonces: Set<string>;
  readers: Set<Reader<T>>;
  controller: AbortController;
  sealed: boolean;
}

/** Collect peers before requesting heads. A later caller always gets a new observation. */
export class WalletSnapshotBatch<T> {
  readonly #pending = new Map<string, Batch<T>>();

  read(key: string, nonces: readonly string[], signal: AbortSignal | undefined,
    observe: (nonces: ReadonlySet<string>, signal: AbortSignal, seal: () => void) => Promise<T>): Promise<T> {
    const canceled = () => new WalletError("WALLET_OPERATION_ABORTED", "The RPC request was canceled.");
    if (signal?.aborted) return Promise.reject(canceled());
    let group = this.#pending.get(key);
    if (!group || new Set([...group.nonces, ...nonces]).size > 1024) {
      const batch: Batch<T> = { nonces: new Set(), readers: new Set(), controller: new AbortController(), sealed: false };
      this.#pending.set(key, batch);
      const seal = () => { batch.sealed = true; if (this.#pending.get(key) === batch) this.#pending.delete(key); };
      setTimeout(async () => {
        if (!batch.readers.size) return;
        try {
          const result = await observe(batch.nonces, batch.controller.signal, seal);
          for (const reader of batch.readers) reader.resolve(result);
        } catch (error) {
          for (const reader of batch.readers) reader.reject(error);
        } finally { seal(); }
      }, 12);
      group = batch;
    }
    const batch = group;
    for (const nonce of nonces) batch.nonces.add(nonce);
    return new Promise((resolve, reject) => {
      const detach = () => {
        batch.readers.delete(reader);
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        detach();
        reject(canceled());
        if (!batch.sealed && nonces.length) {
          batch.nonces.clear();
          for (const other of batch.readers) for (const nonce of other.nonces) batch.nonces.add(nonce);
        }
        if (!batch.readers.size) {
          if (this.#pending.get(key) === batch) this.#pending.delete(key);
          batch.controller.abort();
        }
      };
      const reader: Reader<T> = {
        nonces,
        resolve(value) { detach(); resolve(structuredClone(value)); },
        reject(error) { detach(); reject(error); },
      };
      batch.readers.add(reader);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}
