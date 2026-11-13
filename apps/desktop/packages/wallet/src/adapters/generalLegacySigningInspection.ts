import { z } from "zod";
import type { ProtectedStore } from "../app/ports.js";
import type { GeneralSigningJournalRepository } from "../app/generalSigningTypes.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { canonical, digest } from "./canonical.js";
import { legacySigningGenesis, parseLegacySigningEvents, parseLegacySigningRegistry } from "./generalSigningJournal.js";
import { pageGeneralSigningRisks } from "./generalSigningRiskMath.js";

const REGISTRY = "general-signing-registry-v1";
const MAX_REGISTRY = 512 * 1024;
const MAX_JOURNAL = 32 * 1024 * 1024;
const MAX_ACTIVE = 1000;
const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
type LegacyRegistry = ReturnType<typeof parseLegacySigningRegistry>;
function fail(): never { throw new WalletError("SIGNING_CONTINUITY_UNKNOWN", "General wallet signing continuity cannot be verified."); }

/**
 * Internal v1 verifier. The caller must hold the same exclusive domain lease used by the writer
 * and verify the protected wallet identity independently; no mutation or signing API is exposed.
 */
export async function inspectLegacyGeneralSigningJournal(input: {
  protection: Pick<ProtectedStore, "get">;
  repository: Pick<GeneralSigningJournalRepository, "listStreams" | "read" | "byteSize">;
  ownerId: string; installationId: string; isLive: () => boolean; signal?: AbortSignal;
}): Promise<{ status: "legacy_policy_unverified"; ownerId: string; installationId: string;
  streams: Array<{ accountAddress: string; networkId: string; sequence: number; headDigest: string;
    risks: ReturnType<typeof pageGeneralSigningRisks>["items"] }> }> {
  const current = () => requireWallet(!input.signal?.aborted && input.isLive() === true,
    "SIGNING_CONTINUITY_UNKNOWN", "The legacy inspection owner is unavailable.");
  const readLegacy = async (): Promise<LegacyRegistry> => {
    current();
    const bytes = await input.protection.get(REGISTRY);
    if (!bytes) return fail();
    try {
      current();
      requireWallet(bytes.byteLength <= MAX_REGISTRY, "SIGNING_CONTINUITY_UNKNOWN", "The legacy registry is invalid.");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes), raw: unknown = JSON.parse(text);
      requireWallet(canonical(raw) === text, "SIGNING_CONTINUITY_UNKNOWN", "The legacy registry is invalid.");
      return parseLegacySigningRegistry(raw);
    } catch { return fail(); } finally { bytes.fill(0); }
  };
  const registry = await readLegacy();
  requireWallet(id.safeParse(input.ownerId).success && id.safeParse(input.installationId).success &&
    registry.ownerId === input.ownerId && registry.installationId === input.installationId,
  "SIGNING_CONTINUITY_UNKNOWN", "The legacy registry belongs to another wallet.");
  const known = new Set(registry.streams.map((stream) => stream.id));
  const checkStreams = () => {
    current();
    const listed = input.repository.listStreams(), bytes = input.repository.byteSize();
    requireWallet(Array.isArray(listed) && new Set(listed).size === listed.length && listed.every((item) => known.has(item)) &&
      Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= MAX_JOURNAL,
    "SIGNING_CONTINUITY_CONFLICT", "The legacy journal cannot be verified.");
  };
  checkStreams();
  const seenRisks = new Set<string>(), seenTransfers = new Set<string>(), eventsByStream = new Map<string, string>();
  const streams = registry.streams.map((stream) => {
    current();
    const { events, active } = parseLegacySigningEvents(stream, input.repository.read(stream.id));
    requireWallet(events.length === stream.sequence && (events.at(-1)?.digest ?? legacySigningGenesis(stream.id)) === stream.headDigest,
      "SIGNING_CONTINUITY_CONFLICT", "The legacy journal does not match its protected head.");
    for (const risk of active.values()) {
      requireWallet(!seenRisks.has(risk.riskId) && !seenTransfers.has(risk.transferId) && seenRisks.size < MAX_ACTIVE,
        "SIGNING_CONTINUITY_CONFLICT", "The legacy journal contains duplicate risks.");
      seenRisks.add(risk.riskId); seenTransfers.add(risk.transferId);
    }
    eventsByStream.set(stream.id, digest(events));
    return { accountAddress: stream.accountAddress, networkId: stream.networkId, sequence: stream.sequence,
      headDigest: stream.headDigest, risks: [...active.values()].map((risk) => {
        const signed = events.find((event) => event.phase === "SIGNED" && event.risk.riskId === risk.riskId);
        return { risk: structuredClone(risk), phase: signed ? "SIGNED" as const : "SIGNING_POSSIBLE" as const,
          ...(signed?.transactionHash ? { transactionHash: signed.transactionHash } : {}) };
      }) };
  });
  checkStreams();
  for (const stream of registry.streams) {
    current();
    requireWallet(digest(input.repository.read(stream.id)) === eventsByStream.get(stream.id),
      "SIGNING_CONTINUITY_CONFLICT", "The legacy journal changed during inspection.");
  }
  const verifiedAgain = await readLegacy();
  requireWallet(digest(verifiedAgain) === digest(registry), "SIGNING_CONTINUITY_CONFLICT", "The legacy registry changed during inspection.");
  current();
  return { status: "legacy_policy_unverified", ownerId: registry.ownerId, installationId: registry.installationId, streams };
}
