import { requireWallet } from "../domain/errors.js";
import type { GeneralSigningEvent, GeneralSigningJournalRepository } from "../app/generalSigningTypes.js";
import { canonical } from "./canonical.js";
import { assertGeneralSigningInventory } from "../domain/generalSigningInventory.js";

type Stream = { id: string; accountAddress: string; networkId: string; sequence: number; headDigest: string };
type Registry = { ownerId: string; installationId: string; domainId: string; signingPolicyVersion: number;
  signingPolicyDigest: string; streams: Stream[] };
export type GeneralSigningCheckpoint = { format: "koincode-general-signing-checkpoint"; version: 1;
  ownerId: string; installationId: string; domainId: string; signingPolicyVersion: number; signingPolicyDigest: string;
  streams: Array<Stream & { events: GeneralSigningEvent[] }> };
const MAX_HISTORY = 8 * 1024 * 1024;

/** Builds a detached snapshot only from streams validated by the journal's single writer. */
export function buildGeneralSigningCheckpoint(registry: Registry, repository: GeneralSigningJournalRepository,
  verify: (stream: Stream, events: GeneralSigningEvent[]) => GeneralSigningEvent[]): GeneralSigningCheckpoint {
  const size = repository.byteSize(), listed = repository.listStreams();
  requireWallet(Number.isSafeInteger(size) && size >= 0 && size <= MAX_HISTORY,
    "SIGNING_JOURNAL_CAPACITY_REACHED", "Signing history exceeds the backup limit.");
  assertGeneralSigningInventory(registry.streams, listed);
  const risks = new Set<string>(), transfers = new Set<string>();
  const streams = registry.streams.map((stream) => {
    const events = verify(stream, repository.read(stream.id));
    for (const event of events) if (event.phase === "SIGNING_POSSIBLE") {
      requireWallet(!risks.has(event.risk.riskId) && !transfers.has(event.risk.transferId) && risks.size < 1000,
        "SIGNING_CONTINUITY_CONFLICT", "Signing history contains conflicting risks.");
      risks.add(event.risk.riskId); transfers.add(event.risk.transferId);
    }
    return { ...stream, events };
  });
  const checkpoint: GeneralSigningCheckpoint = { format: "koincode-general-signing-checkpoint", version: 1,
    ownerId: registry.ownerId, installationId: registry.installationId, domainId: registry.domainId,
    signingPolicyVersion: registry.signingPolicyVersion, signingPolicyDigest: registry.signingPolicyDigest, streams };
  requireWallet(Buffer.byteLength(canonical(checkpoint)) <= MAX_HISTORY,
    "SIGNING_JOURNAL_CAPACITY_REACHED", "Signing history exceeds the backup limit.");
  return structuredClone(checkpoint);
}
