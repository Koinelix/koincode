import { WalletError } from "../domain/errors.js";
let workers = 0, backups = 0;
export function generalCryptoWorkerAvailable(backup = false): boolean { return workers < 2 && (!backup || backups < 1); }
/** Capacity only. Release solely after the original worker actually exits or
 * a failed constructor proves no worker was created. Unknown drainage retains
 * its charge; this callback is neither admission nor a signing capability. */
export function reserveGeneralCryptoWorker(backup = false): () => void {
  if (!generalCryptoWorkerAvailable(backup)) throw new WalletError("GENERAL_OPERATION_BUSY", "General wallet workers are busy.");
  workers++; if (backup) backups++;
  let released = false;
  return () => { if (!released) { released = true; workers--; if (backup) backups--; } };
}
