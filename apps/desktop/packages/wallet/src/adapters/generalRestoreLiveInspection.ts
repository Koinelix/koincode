import { createHash } from "node:crypto";
import type { ProtectedStore } from "../app/ports.js";
import type { GeneralWalletState } from "../app/generalState.js";
import type { GeneralSigningJournalRepository } from "../app/generalSigningTypes.js";
import { WalletError } from "../domain/errors.js";
import { assertGeneralSigningInventory } from "../domain/generalSigningInventory.js";
import { canonical, digest } from "./canonical.js";
import { parseGeneralRecoveryRecord, generalRecoveryHash } from "./generalRecoveryRecord.js";
import { parseGeneralSigningCheckpoint } from "./generalSigningJournal.js";
import { inspectGeneralBackupHistory } from "./generalBackupHistoryValidation.js";
import { parseGeneralHistoricalIntentRecord } from "./generalTransferIntentStore.js";
import { inspectGeneralSignedMaterial } from "./generalSignedMaterial.js";
import { parseGeneralBroadcastRecord } from "./generalBroadcastRecord.js";
import type { GeneralBackupHistory } from "./generalBackupHistory.js";

export type GeneralRestoreFact = { reference: string; digest: string | null };
export type GeneralRestoreReadJournal = Pick<GeneralSigningJournalRepository, "listStreams" | "read" | "byteSize">;
const check = (value: unknown): void => { if (!value) throw new WalletError("GENERAL_RECOVERY_RECORD_CONFLICT", "The target signing facts conflict."); };

/** Read-only current facts. No journal owner, persisted checkpoint or signing capability is created. */
export async function inspectGeneralRestoreLiveHistory(state: GeneralWalletState, protection: Pick<ProtectedStore, "get">,
  repository: GeneralRestoreReadJournal, current: () => void): Promise<{ history: GeneralBackupHistory; references: GeneralRestoreFact[] }> {
  const references: GeneralRestoreFact[] = []; let bytesRead = 0;
  const read = async <T>(reference: string, maximum: number, parse: (bytes: Uint8Array | null) => T): Promise<T> => {
    current(); const bytes = await protection.get(reference);
    try {
      current(); check(bytes === null || bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= maximum);
      bytesRead += bytes?.byteLength ?? 0; check(bytesRead <= 48 * 1024 * 1024);
      references.push({ reference, digest: bytes ? createHash("sha256").update(bytes).digest("hex") : null });
      return parse(bytes);
    } finally { bytes?.fill(0); }
  };
  const registry = await read("general-signing-registry-v1", 512 * 1024, (bytes) => {
    check(bytes);
    return parseGeneralRecoveryRecord(bytes!, 512 * 1024, "GENERAL_RECOVERY_RECORD_CONFLICT") as Record<string, unknown>;
  });
  check(registry && typeof registry === "object" && !Array.isArray(registry) &&
    Object.keys(registry).sort().join() === "domainId,format,installationId,ownerId,signingPolicyDigest,signingPolicyVersion,streams,version" &&
    registry.format === "koincode-general-signing-registry" && registry.version === 1 && Array.isArray(registry.streams) && registry.streams.length <= 3584);
  const metadata = registry.streams as Array<{ id: string; sequence: number }>;
  const size = repository.byteSize(); current(); check(Number.isSafeInteger(size) && size >= 0 && size <= 32 * 1024 * 1024);
  let totalEvents = 0, totalBytes = 0;
  const streams = metadata.map((stream) => {
    current(); check(stream && typeof stream === "object" && !Array.isArray(stream) &&
      Object.keys(stream).sort().join() === "accountAddress,headDigest,id,networkId,sequence" && generalRecoveryHash.safeParse(stream.id).success);
    const events = repository.read(stream.id); current(); check(Array.isArray(events) && events.length <= 2000);
    totalEvents += events.length; check(totalEvents <= 2000);
    for (const event of events) { const bytes = Buffer.byteLength(canonical(event)); check(bytes <= 8192); totalBytes += bytes; }
    check(totalBytes <= 8 * 1024 * 1024); return { ...stream, events };
  });
  const listed = repository.listStreams(); current(); assertGeneralSigningInventory(metadata, listed);
  const checkpointBytes = Buffer.from(canonical({ ...registry, format: "koincode-general-signing-checkpoint", streams }));
  let inspected: ReturnType<typeof parseGeneralSigningCheckpoint>;
  try { inspected = parseGeneralSigningCheckpoint(checkpointBytes); } finally { checkpointBytes.fill(0); }
  const checkpoint = inspected.checkpoint;
  check(inspected.policy === "v3" && checkpoint.ownerId === state.ownerId && checkpoint.installationId === state.installationId &&
    checkpoint.signingPolicyVersion === state.signingPolicyVersion && checkpoint.signingPolicyDigest === state.signingPolicyDigest);
  const history: GeneralBackupHistory = { format: "koincode-general-backup-history", version: 1, ownerId: state.ownerId,
    installationId: state.installationId, sourceRevision: state.revision, sourceCommitment: digest(state), signing: checkpoint, intents: [] };
  let risks = 0;
  for (const stream of checkpoint.streams) for (const event of stream.events) if (event.phase === "SIGNING_POSSIBLE") {
    current(); check(++risks <= 1000);
    const risk = event.risk, preview = await read(`general-intent:${risk.riskId}`, 16384, (bytes) => {
      check(bytes); return parseGeneralHistoricalIntentRecord(bytes!, state.ownerId, risk);
    });
    history.intents.push({ riskId: risk.riskId, preview });
    const signed = stream.events.find((entry) => entry.phase === "SIGNED" && entry.risk.riskId === risk.riskId);
    const hash = await read(`general-signed:${risk.riskId}`, 16384, (bytes) => {
      if (!bytes) { check(!signed); return null; }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes), value: unknown = JSON.parse(text);
      check(value && typeof value === "object" && !Array.isArray(value));
      const stored = inspectGeneralSignedMaterial(preview, risk.intentDigest, risk.riskId, (value as { signedTransaction: string }).signedTransaction);
      check(canonical(stored) === text && (!signed || stored.transactionHash === signed.transactionHash)); return stored.transactionHash;
    });
    await read(`general-broadcast:${risk.riskId}`, 4096, (bytes) => {
      if (bytes) { check(signed && hash); parseGeneralBroadcastRecord(bytes, preview, risk.intentDigest, risk.riskId, hash!); }
    });
  }
  const historyBytes = Buffer.from(canonical(history));
  try { check(inspectGeneralBackupHistory(historyBytes).status === "v2_structural_only"); } finally { historyBytes.fill(0); }
  current(); return { history, references };
}
