import type { GeneralSigningEvent, GeneralSigningRisk } from "../app/generalSigningTypes.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { canonical } from "./canonical.js";
import type { GeneralSigningCheckpoint } from "./generalSigningCheckpoint.js";

type Stream = { id: string; accountAddress: string; networkId: string; sequence: number; headDigest: string };
type Registry = { ownerId: string; installationId: string; domainId: string; signingPolicyVersion: number;
  signingPolicyDigest: string; streams: Stream[] };
type Validators = {
  registry(value: unknown, legacy: boolean): Registry;
  events(stream: Stream, raw: GeneralSigningEvent[], policyDigest: string): { events: GeneralSigningEvent[]; active: Map<string, GeneralSigningRisk> };
  genesis(streamId: string, policyDigest: string): string;
};

/** Parses a bounded history component only; hashes here do not establish backup authenticity or signing authority. */
export function inspectGeneralSigningCheckpoint(bytes: Uint8Array, validators: Validators): {
  policy: "v3" | "previous_v2" | "legacy_v1"; checkpoint: GeneralSigningCheckpoint;
} {
  try {
    requireWallet(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= 8 * 1024 * 1024,
      "GENERAL_BACKUP_HISTORY_INVALID", "The signing checkpoint is invalid.");
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), parsed: unknown = JSON.parse(text);
    requireWallet(parsed && typeof parsed === "object" && !Array.isArray(parsed) && canonical(parsed) === text,
      "GENERAL_BACKUP_HISTORY_INVALID", "The signing checkpoint is invalid.");
    const row = parsed as Record<string, unknown>;
    requireWallet(Object.keys(row).sort().join() === "domainId,format,installationId,ownerId,signingPolicyDigest,signingPolicyVersion,streams,version" &&
      row.format === "koincode-general-signing-checkpoint" && row.version === 1 && Array.isArray(row.streams) && row.streams.length <= 3584,
    "GENERAL_BACKUP_HISTORY_INVALID", "The signing checkpoint is invalid.");
    const inputs = row.streams.map((value: unknown) => {
      requireWallet(value && typeof value === "object" && !Array.isArray(value), "GENERAL_BACKUP_HISTORY_INVALID", "The signing stream is invalid.");
      const stream = value as Record<string, unknown>;
      requireWallet(Object.keys(stream).sort().join() === "accountAddress,events,headDigest,id,networkId,sequence" && Array.isArray(stream.events),
        "GENERAL_BACKUP_HISTORY_INVALID", "The signing stream is invalid.");
      const { events, ...metadata } = stream;
      return { metadata, events: events as GeneralSigningEvent[] };
    });
    const legacy = row.signingPolicyVersion === 1;
    const registry = validators.registry({ format: "koincode-general-signing-registry", version: 1, ownerId: row.ownerId,
      installationId: row.installationId, domainId: row.domainId, signingPolicyVersion: row.signingPolicyVersion,
      signingPolicyDigest: row.signingPolicyDigest, streams: inputs.map((item) => item.metadata) }, legacy);
    const risks = new Set<string>(), transfers = new Set<string>();
    const streams = registry.streams.map((stream, index) => {
      const checked = validators.events(stream, inputs[index]!.events, registry.signingPolicyDigest);
      requireWallet(checked.events.length === stream.sequence &&
        (checked.events.at(-1)?.digest ?? validators.genesis(stream.id, registry.signingPolicyDigest)) === stream.headDigest,
      "GENERAL_BACKUP_HISTORY_INVALID", "The signing stream head is invalid.");
      for (const risk of checked.active.values()) {
        requireWallet(!risks.has(risk.riskId) && !transfers.has(risk.transferId) && risks.size < 1000,
          "GENERAL_BACKUP_HISTORY_INVALID", "The signing checkpoint contains conflicting risks.");
        risks.add(risk.riskId); transfers.add(risk.transferId);
      }
      return { ...stream, events: checked.events };
    });
    return { policy: legacy ? "legacy_v1" : registry.signingPolicyVersion === 2 ? "previous_v2" : "v3", checkpoint: { format: "koincode-general-signing-checkpoint", version: 1,
      ownerId: registry.ownerId, installationId: registry.installationId, domainId: registry.domainId,
      signingPolicyVersion: registry.signingPolicyVersion, signingPolicyDigest: registry.signingPolicyDigest, streams } };
  } catch {
    throw new WalletError("GENERAL_BACKUP_HISTORY_INVALID", "The signing checkpoint cannot be verified.");
  }
}
