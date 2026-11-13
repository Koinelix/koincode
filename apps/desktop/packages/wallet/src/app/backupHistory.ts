import { budgetView } from "../domain/budget.js";
import { requireWallet, WalletError } from "../domain/errors.js";
import { networkConfig } from "../domain/networks.js";
import type { BackupMetadata } from "./ports.js";
import type { StateCommitment, WalletState } from "./state.js";
import { disabledLimits, walletRecord } from "./runtimeContext.js";
export interface BackupHistory {
  version: 1 | 2 | 3;
  walletId: string;
  continuityAtExport: boolean;
  state: WalletState;
  commitment: StateCommitment;
}
export function validateBackupHistory(
  metadata: BackupMetadata,
  verify: (state: WalletState, commitment: StateCommitment) => void,
): BackupHistory {
  try {
    const history = JSON.parse(metadata.history) as BackupHistory;
    requireWallet(
      (history.version === 1 || history.version === 2 || history.version === 3) &&
        typeof history.walletId === "string" &&
        typeof history.continuityAtExport === "boolean",
      "BACKUP_INVALID",
      "Backup history is unsupported.",
    );
    verify(history.state, history.commitment);
    requireWallet(history.version === 3
      ? Array.isArray(history.state.transport?.journalAnchors) && history.state.transport.journalAnchors.length > 0
      : history.state.transport?.journalAnchors === undefined && (history.version === 1
        ? history.state.transport?.retentions === undefined
        : Array.isArray(history.state.transport?.retentions) && history.state.transport.retentions.length > 0),
    "BACKUP_INVALID", "Transport history requires its versioned backup contract.");
    const wallet = walletRecord(history.state, history.walletId);
    requireWallet(
      wallet.address.toLowerCase() === metadata.address.toLowerCase() &&
        wallet.network === metadata.network &&
        wallet.asset.toLowerCase() === metadata.asset.toLowerCase() &&
        wallet.baselineBlock === metadata.baselineBlock &&
        wallet.baselineHash === metadata.baselineHash &&
        metadata.asset.toLowerCase() === networkConfig(metadata.network).asset,
      "BACKUP_INVALID",
      "Authenticated baseline and history identity differ.",
    );
    const subject = history.state.subjects.find(
      (subject) => subject.subjectId === wallet.subjectId,
    );
    requireWallet(
      subject &&
        subject.address.toLowerCase() === wallet.address.toLowerCase() &&
        subject.network === wallet.network &&
        subject.asset.toLowerCase() === wallet.asset.toLowerCase() &&
        subject.ownerId === history.state.ownerId,
      "BACKUP_INVALID",
      "Backup budget subject is inconsistent.",
    );
    budgetView(subject, disabledLimits(), history.state.events, history.state.trustedTime);
    return history;
  } catch {
    throw new WalletError("BACKUP_INVALID", "The authenticated backup history is invalid.");
  }
}
