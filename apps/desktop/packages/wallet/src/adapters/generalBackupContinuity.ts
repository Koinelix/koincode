import { requireWallet } from "../domain/errors.js";
import { canonical, digest } from "./canonical.js";
import { GeneralBackupHistoryReader, type GeneralBackupHistory } from "./generalBackupHistory.js";
import { inspectGeneralBackupHistory } from "./generalBackupHistoryValidation.js";

type Observation =
  | { status: "legacy_policy_unverified" }
  | { status: "unknown"; reason: "different_domain" | "candidate_ahead_or_missing" }
  | { status: "conflict"; reason: "source_commitment" | "signing_prefix" | "intent" }
  | { status: "prefix_consistent"; newerEvents: number; newerRisks: number };
let active = 0;

/** Read-only evidence. Even a matching prefix does not authenticate the backup or authorize a restore. */
export class GeneralBackupContinuityReader {
  private busy = false;
  constructor(private readonly reader: GeneralBackupHistoryReader) {}

  async inspect(bytes: Uint8Array, signal: AbortSignal): Promise<Observation> {
    requireWallet(!signal.aborted && !this.busy && active < 2, "GENERAL_OPERATION_BUSY", "Backup comparison is unavailable or busy.");
    this.busy = true; active++;
    try {
      const candidate = inspectGeneralBackupHistory(bytes);
      requireWallet(!signal.aborted, "GENERAL_OPERATION_CANCELED", "Backup comparison was canceled.");
      if (candidate.status === "legacy_policy_unverified") return { status: "legacy_policy_unverified" };
      const current = await this.reader.capture(signal);
      const result = compareGeneralBackupHistories(candidate.history, current);
      const latest = await this.reader.capture(signal);
      requireWallet(!signal.aborted, "GENERAL_OPERATION_CANCELED", "Backup comparison was canceled.");
      requireWallet(digest(latest) === digest(current), "GENERAL_BACKUP_HISTORY_CHANGED", "The wallet changed during backup comparison.");
      return result;
    } finally { this.busy = false; active--; }
  }
}

/** Validated history comparison only; no authenticity, current native head or signing authority is established. */
export function compareGeneralBackupHistories(candidate: GeneralBackupHistory, current: GeneralBackupHistory): Observation {
  const earlier = candidate.signing, latest = current.signing;
  if (candidate.ownerId !== current.ownerId || candidate.installationId !== current.installationId || earlier.domainId !== latest.domainId ||
      earlier.signingPolicyVersion !== latest.signingPolicyVersion || earlier.signingPolicyDigest !== latest.signingPolicyDigest)
    return { status: "unknown", reason: "different_domain" };
  if (candidate.sourceRevision > current.sourceRevision) return { status: "unknown", reason: "candidate_ahead_or_missing" };
  if (candidate.sourceRevision === current.sourceRevision && candidate.sourceCommitment !== current.sourceCommitment)
    return { status: "conflict", reason: "source_commitment" };
  const currentStreams = new Map(latest.streams.map((stream) => [stream.id, stream]));
  const currentIntents = new Map(current.intents.map((item) => [item.riskId, item]));
  let earlierEvents = 0;
  for (const stream of earlier.streams) {
    const target = currentStreams.get(stream.id);
    if (!target || stream.sequence > target.sequence) return { status: "unknown", reason: "candidate_ahead_or_missing" };
    if (stream.accountAddress !== target.accountAddress || stream.networkId !== target.networkId ||
        stream.events.some((event, index) => canonical(event) !== canonical(target.events[index])))
      return { status: "conflict", reason: "signing_prefix" };
    earlierEvents += stream.events.length;
  }
  for (const item of candidate.intents) {
    const target = currentIntents.get(item.riskId);
    if (!target || canonical(item) !== canonical(target)) return { status: "conflict", reason: "intent" };
  }
  const totalEvents = latest.streams.reduce((sum, stream) => sum + stream.events.length, 0);
  return { status: "prefix_consistent", newerEvents: totalEvents - earlierEvents, newerRisks: current.intents.length - candidate.intents.length };
}
