import { requireWallet } from "../domain/errors.js";
import { canonical, digest } from "./canonical.js";
import { GeneralGuardedState } from "./generalGuardedState.js";
import { GeneralSigningJournal } from "./generalSigningJournal.js";
import { GeneralTransferIntentStore } from "./generalTransferIntentStore.js";
import type { GeneralSigningCheckpoint } from "./generalSigningCheckpoint.js";
import type { GeneralTransferPreview } from "./generalTransferIntent.js";

const MAX_HISTORY = 8 * 1024 * 1024;
let activeReaders = 0;
export type GeneralBackupHistory = { format: "koincode-general-backup-history"; version: 1; ownerId: string;
  installationId: string; sourceRevision: number; sourceCommitment: string; signing: GeneralSigningCheckpoint;
  intents: Array<{ riskId: string; preview: GeneralTransferPreview }> };

/** Point-in-time, internal backup input. It grants no signing, restore or history authority. */
export class GeneralBackupHistoryReader {
  private active = false;
  constructor(private readonly owner: GeneralGuardedState, private readonly journal: GeneralSigningJournal,
    private readonly intents: GeneralTransferIntentStore) {}

  async capture(signal: AbortSignal): Promise<GeneralBackupHistory> {
    requireWallet(!signal.aborted && !this.active && activeReaders < 2, "GENERAL_OPERATION_BUSY", "Backup history is unavailable or busy.");
    this.active = true; activeReaders++;
    try {
      const source = this.owner.snapshot(), sourceCommitment = digest(source);
      const current = () => {
        requireWallet(!signal.aborted && this.owner.isLive(source.ownerId, source.installationId),
          "GENERAL_OPERATION_CANCELED", "The backup operation was canceled.");
        const latest = this.owner.snapshot();
        requireWallet(latest.revision === source.revision && digest(latest) === sourceCommitment,
          "GENERAL_BACKUP_HISTORY_CHANGED", "The wallet changed during backup history collection.");
      };
      const signing = await this.journal.checkpointForBackup(); current();
      requireWallet(signing.ownerId === source.ownerId && signing.installationId === source.installationId,
        "SIGNING_CONTINUITY_CONFLICT", "The signing history belongs to another wallet.");
      const result: GeneralBackupHistory = { format: "koincode-general-backup-history", version: 1,
        ownerId: source.ownerId, installationId: source.installationId, sourceRevision: source.revision,
        sourceCommitment, signing, intents: [] };
      let bytes = Buffer.byteLength(canonical(result));
      for (const stream of signing.streams) for (const event of stream.events) if (event.phase === "SIGNING_POSSIBLE") {
        current();
        const preview = await this.intents.readForRecovery(source.ownerId, event.risk); current();
        const item = { riskId: event.risk.riskId, preview };
        bytes += Buffer.byteLength(canonical(item)) + 1;
        requireWallet(bytes <= MAX_HISTORY, "SIGNING_JOURNAL_CAPACITY_REACHED", "Backup history exceeds the size limit.");
        result.intents.push(item);
      }
      const latest = await this.journal.checkpointForBackup(); current();
      requireWallet(digest(latest) === digest(signing), "GENERAL_BACKUP_HISTORY_CHANGED", "Signing history changed during backup collection.");
      requireWallet(Buffer.byteLength(canonical(result)) <= MAX_HISTORY,
        "SIGNING_JOURNAL_CAPACITY_REACHED", "Backup history exceeds the size limit.");
      return result;
    } finally { this.active = false; activeReaders--; }
  }
}
