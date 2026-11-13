import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { ProtectedStore } from "../app/ports.js";
import type { GeneralSigningRisk, GeneralSigningEvent, GeneralSigningJournalRepository } from "../app/generalSigningTypes.js";
export type { GeneralSigningRisk, GeneralSigningEvent, GeneralSigningJournalRepository } from "../app/generalSigningTypes.js";
import { generalNetwork } from "../domain/generalNetworks.js";
import { assertGeneralSigningNetwork, GENERAL_SIGNING_POLICY_DIGEST, GENERAL_SIGNING_POLICY_VERSION,
  LEGACY_GENERAL_SIGNING_POLICY_DIGEST, PREVIOUS_GENERAL_SIGNING_POLICY_DIGEST } from "../domain/generalSigningPolicy.js";
import { assertGeneralSigningPolicy } from "../app/generalSigningPolicyVerification.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { canonical, digest } from "./canonical.js";
import { consumeFreshSigningDomainTicket, GeneralGuardedState } from "./generalGuardedState.js";
import { generalEvidenceIsLive, issueGeneralSignerPermit, type GeneralEvidenceLifetime } from "./generalSigningCapability.js";
import { GeneralUnsignedNonceReservations } from "./generalUnsignedNonceReservations.js";
import { consumeGeneralSignedMaterialProof } from "./generalSignedMaterial.js";
import { issueGeneralBroadcastPermit } from "./generalBroadcastCapability.js";
import { pageGeneralSigningRisks, sumGeneralSigningRisk } from "./generalSigningRiskMath.js";
import { buildGeneralSigningCheckpoint, type GeneralSigningCheckpoint } from "./generalSigningCheckpoint.js";
import { inspectGeneralSigningCheckpoint } from "./generalSigningCheckpointValidation.js";
import { generalSigningRiskSchema, parseGeneralSigningRisk } from "./generalSigningRiskValidation.js";
import { assertGeneralSigningInventory } from "../domain/generalSigningInventory.js";
import { GeneralSnapshotQueue } from "./generalSnapshotQueue.js";

const REGISTRY = "general-signing-registry-v1";
const MAX_REGISTRY = 512 * 1024;
const MAX_JOURNAL = 32 * 1024 * 1024;
const MAX_ACTIVE = 1000;
const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const streamSchema = z.strictObject({ id: hash, accountAddress: address, networkId: z.string(), sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), headDigest: hash });
const registrySchema = z.strictObject({ format: z.literal("koincode-general-signing-registry"), version: z.literal(1),
  ownerId: id, installationId: id, domainId: id, signingPolicyVersion: z.literal(GENERAL_SIGNING_POLICY_VERSION),
  signingPolicyDigest: z.literal(GENERAL_SIGNING_POLICY_DIGEST), streams: z.array(streamSchema).max(3584) });
const previousRegistrySchema = registrySchema.extend({ signingPolicyVersion: z.literal(2), signingPolicyDigest: z.literal(PREVIOUS_GENERAL_SIGNING_POLICY_DIGEST) });
const legacyRegistrySchema = registrySchema.extend({ signingPolicyVersion: z.literal(1), signingPolicyDigest: z.literal(LEGACY_GENERAL_SIGNING_POLICY_DIGEST) });
const eventSchema = z.strictObject({ version: z.literal(1), streamId: hash, sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  previousDigest: hash, phase: z.enum(["SIGNING_POSSIBLE", "SIGNED"]), risk: generalSigningRiskSchema,
  transactionHash: z.string().regex(/^0x[0-9a-f]{64}$/).optional(), digest: hash });
type Registry = z.infer<typeof registrySchema>;
type LegacyRegistry = z.infer<typeof legacyRegistrySchema>;
type Stream = z.infer<typeof streamSchema>;
function fail(code = "SIGNING_CONTINUITY_UNKNOWN"): never {
  throw new WalletError(code, "General wallet signing continuity cannot be verified.");
}
function streamId(domainId: string, accountAddress: string, networkId: string): string {
  return digest(["koincode-general-signing-stream", 1, domainId, accountAddress, networkId]);
}
function genesis(idValue: string, policyDigest: string = GENERAL_SIGNING_POLICY_DIGEST): string { return digest(["koincode-general-signing-genesis", 1, idValue, policyDigest]); }
function parseRegistryForPolicy(value: unknown, legacy: boolean, historical = false): Registry | LegacyRegistry | z.infer<typeof previousRegistrySchema> {
  assertGeneralSigningPolicy();
  const previous = historical && (value as { signingPolicyVersion?: unknown })?.signingPolicyVersion === 2;
  const parsed = (legacy ? legacyRegistrySchema : previous ? previousRegistrySchema : registrySchema).safeParse(value);
  if (!parsed.success) return fail();
  const registry = parsed.data, ids = new Set<string>();
  for (const stream of registry.streams) {
    const network = generalNetwork(stream.networkId);
    if (legacy || previous) requireWallet(network.id !== "eip155:84532", "SIGNING_CONTINUITY_CONFLICT", "The archived signing network was reserved.");
    else assertGeneralSigningNetwork(network.id, BigInt(network.chainId));
    requireWallet(!ids.has(stream.id) && stream.id === streamId(registry.domainId, stream.accountAddress, stream.networkId) &&
      (stream.sequence !== 0 || stream.headDigest === genesis(stream.id, registry.signingPolicyDigest)),
    "SIGNING_CONTINUITY_CONFLICT", "The signing stream registry is invalid.");
    ids.add(stream.id);
  }
  return registry;
}
function parseRegistry(value: unknown): Registry { return parseRegistryForPolicy(value, false) as Registry; }
/** Read-only migration validation; never repairs or grants signing authority. */
export function inspectGeneralSigningRegistry(value: unknown) {
  return parseRegistryForPolicy(value, (value as { signingPolicyVersion?: unknown })?.signingPolicyVersion === 1, true);
}
/** Internal read-only parser; this returns no journal owner or signing capability. */
export function parseLegacySigningRegistry(value: unknown): LegacyRegistry { return parseRegistryForPolicy(value, true) as LegacyRegistry; }
export function legacySigningGenesis(idValue: string): string { return genesis(idValue, LEGACY_GENERAL_SIGNING_POLICY_DIGEST); }
function parseEvents(stream: Stream, raw: GeneralSigningEvent[], policyDigest: string = GENERAL_SIGNING_POLICY_DIGEST): { events: GeneralSigningEvent[]; active: Map<string, GeneralSigningRisk> } {
  requireWallet(Array.isArray(raw) && raw.length <= 2000, "SIGNING_JOURNAL_CAPACITY_REACHED", "The signing journal is full.");
  const active = new Map<string, GeneralSigningRisk>(), transfers = new Set<string>(), nonces = new Set<number>();
  let previous = genesis(stream.id, policyDigest);
  const events: GeneralSigningEvent[] = [];
  for (const [index, input] of raw.entries()) {
    const parsed = eventSchema.safeParse(input);
    if (!parsed.success) return fail("SIGNING_CONTINUITY_CONFLICT");
    const event = parsed.data, risk = parseGeneralSigningRisk(event.risk, policyDigest !== GENERAL_SIGNING_POLICY_DIGEST);
    const { digest: actual, ...body } = event;
    requireWallet(event.streamId === stream.id && event.sequence === index + 1 && event.previousDigest === previous &&
      actual === digest(body) && risk.accountAddress === stream.accountAddress && risk.networkId === stream.networkId,
    "SIGNING_CONTINUITY_CONFLICT", "The signing journal chain is invalid.");
    if (event.phase === "SIGNING_POSSIBLE") {
      requireWallet(!event.transactionHash && !active.has(risk.riskId) && !transfers.has(risk.transferId) && !nonces.has(risk.nonce),
        "SIGNING_CONTINUITY_CONFLICT", "The signing risk is duplicated.");
      active.set(risk.riskId, risk); transfers.add(risk.transferId); nonces.add(risk.nonce);
    } else {
      const existing = active.get(risk.riskId);
      requireWallet(event.transactionHash && existing && digest(existing) === digest(risk) &&
        !events.some((item) => item.risk.riskId === risk.riskId && item.phase === "SIGNED"),
      "SIGNING_CONTINUITY_CONFLICT", "The signed result is inconsistent.");
    }
    previous = actual; events.push(event);
  }
  requireWallet(active.size <= MAX_ACTIVE, "SIGNING_JOURNAL_CAPACITY_REACHED", "The signing journal is full.");
  return { events, active };
}
export function parseLegacySigningEvents(stream: Stream, raw: GeneralSigningEvent[]): ReturnType<typeof parseEvents> {
  return parseEvents(stream, raw, LEGACY_GENERAL_SIGNING_POLICY_DIGEST);
}
/** Internal untrusted-input validation only; it never grants restore or signing authority. */
export function parseGeneralSigningCheckpoint(bytes: Uint8Array): ReturnType<typeof inspectGeneralSigningCheckpoint> {
  return inspectGeneralSigningCheckpoint(bytes, { registry: (value, legacy) => parseRegistryForPolicy(value, legacy, true), events: parseEvents, genesis });
}
async function readRegistry(protection: ProtectedStore): Promise<Registry | null> {
  const bytes = await protection.get(REGISTRY);
  if (!bytes) return null;
  try {
    if (bytes.byteLength > MAX_REGISTRY) return fail();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const raw: unknown = JSON.parse(text);
    if (canonical(raw) !== text) return fail();
    return parseRegistry(raw);
  } catch { return fail(); }
  finally { bytes.fill(0); }
}
async function writeRegistry(protection: ProtectedStore, registry: Registry): Promise<void> {
  const value = parseRegistry(registry), bytes = Buffer.from(canonical(value));
  requireWallet(bytes.byteLength <= MAX_REGISTRY, "SIGNING_JOURNAL_CAPACITY_REACHED", "The signing registry is full.");
  try {
    await protection.put(REGISTRY, bytes);
    const readback = await readRegistry(protection);
    requireWallet(readback && digest(readback) === digest(value), "SIGNING_CONTINUITY_UNKNOWN", "The signing checkpoint cannot be confirmed.");
  } finally { bytes.fill(0); }
}
/** A journal receipt is an opaque, one-use capability held only by this owner. */
export class GeneralSigningJournal extends GeneralSnapshotQueue {
  private broken = false;
  private closed = false;
  private readonly tickets = new WeakMap<object, { risk: GeneralSigningRisk; proof: GeneralEvidenceLifetime }>();
  private readonly started = new Map<string, "pending" | { digest: string; proof: GeneralEvidenceLifetime }>();
  private readonly unsigned = new GeneralUnsignedNonceReservations();
  private constructor(private readonly repository: GeneralSigningJournalRepository, private readonly protection: ProtectedStore,
    private registry: Registry, private readonly isFreshSource: (accountAddress: string, networkId: string) => Promise<boolean>,
    private readonly now: () => number, private readonly ownerIsLive: () => boolean) { super(); }
  static async initialize(repository: GeneralSigningJournalRepository, protection: ProtectedStore, ownerId: string, freshTicket: object,
    isFreshSource: (accountAddress: string, networkId: string) => Promise<boolean>,
    now: () => number = () => Math.floor(performance.now())): Promise<GeneralSigningJournal> {
    let lease: ReturnType<typeof consumeFreshSigningDomainTicket> | undefined;
    try {
      lease = consumeFreshSigningDomainTicket(freshTicket, ownerId);
      requireWallet(lease.matchesProtection(protection), "SIGNING_CONTINUITY_UNKNOWN", "The signing protection does not match its wallet owner.");
      const existing = await readRegistry(protection);
      requireWallet(lease.valid() && id.safeParse(ownerId).success && existing === null && repository.listStreams().length === 0,
        "SIGNING_CONTINUITY_UNKNOWN", "A signing domain can only be explicitly created without existing history.");
      const registry: Registry = { format: "koincode-general-signing-registry", version: 1, ownerId, installationId: lease.installationId, domainId: lease.initialDomainId ?? randomUUID(),
        signingPolicyVersion: GENERAL_SIGNING_POLICY_VERSION, signingPolicyDigest: GENERAL_SIGNING_POLICY_DIGEST, streams: [] };
      await writeRegistry(protection, registry);
      requireWallet(lease.valid(), "SIGNING_CONTINUITY_UNKNOWN", "The signing domain owner is no longer available.");
      return new GeneralSigningJournal(repository, protection, registry, isFreshSource, now, lease.ownerIsLive);
    } catch (error) { repository.close(); throw error; }
    finally { lease?.release(); }
  }
  static async open(repository: GeneralSigningJournalRepository, protection: ProtectedStore, owner: GeneralGuardedState,
    isFreshSource: (accountAddress: string, networkId: string) => Promise<boolean>,
    now: () => number = () => Math.floor(performance.now())): Promise<GeneralSigningJournal> {
    try {
      requireWallet(owner instanceof GeneralGuardedState && owner.isBoundTo(protection), "SIGNING_CONTINUITY_UNKNOWN", "The signing owner is unavailable.");
      let identity: ReturnType<GeneralGuardedState["snapshot"]>;
      try { identity = owner.snapshot(); } catch { return fail(); }
      const { ownerId, installationId } = identity;
      const ownerIsLive = () => owner.isLive(ownerId, installationId);
      const registry = await readRegistry(protection);
      requireWallet(ownerIsLive() && registry && registry.ownerId === ownerId && registry.installationId === installationId,
        "SIGNING_CONTINUITY_UNKNOWN", "The signing registry is unavailable.");
      const known = new Set(registry.streams.map((stream) => stream.id));
      requireWallet(repository.listStreams().every((stream) => known.has(stream)), "SIGNING_CONTINUITY_CONFLICT", "The signing journal has an unknown stream.");
      let advanced = false, activeCount = 0;
      const riskIds = new Set<string>(), transferIds = new Set<string>();
      for (const stream of registry.streams) {
        const { events, active } = parseEvents(stream, repository.read(stream.id));
        activeCount += active.size;
        for (const risk of active.values()) {
          requireWallet(!riskIds.has(risk.riskId) && !transferIds.has(risk.transferId),
            "SIGNING_CONTINUITY_CONFLICT", "The signing risk is duplicated across streams.");
          riskIds.add(risk.riskId); transferIds.add(risk.transferId);
        }
        requireWallet(events.length >= stream.sequence, "SIGNING_CONTINUITY_INCOMPLETE", "The signing journal is missing protected history.");
        const protectedDigest = stream.sequence ? events[stream.sequence - 1]?.digest : genesis(stream.id);
        requireWallet(protectedDigest === stream.headDigest, "SIGNING_CONTINUITY_CONFLICT", "The signing journal disagrees with its protected head.");
        if (events.length > stream.sequence) {
          stream.sequence = events.length; stream.headDigest = events.at(-1)!.digest; advanced = true;
        }
      }
      requireWallet(repository.byteSize() <= MAX_JOURNAL && activeCount <= MAX_ACTIVE, "SIGNING_JOURNAL_CAPACITY_REACHED", "The signing journal is full.");
      if (advanced) await writeRegistry(protection, registry);
      requireWallet(ownerIsLive(), "SIGNING_CONTINUITY_UNKNOWN", "The signing owner is unavailable.");
      return new GeneralSigningJournal(repository, protection, registry, isFreshSource, now, ownerIsLive);
    } catch (error) { repository.close(); throw error; }
  }
  protected assertAvailable(): void { requireWallet(!this.closed && !this.broken && this.ownerIsLive(), "SIGNING_CONTINUITY_UNKNOWN", "The signing journal is unavailable."); }
  private async checkRegistry(): Promise<void> {
    const latest = await readRegistry(this.protection);
    this.assertAvailable();
    if (!latest || digest(latest) !== digest(this.registry)) { this.broken = true; fail("SIGNING_CONTINUITY_CONFLICT"); }
  }
  async registerFreshStream(accountAddress: string, networkId: string): Promise<void> {
    return await this.exclusive(async () => {
      await this.checkRegistry();
      const network = generalNetwork(networkId);
      assertGeneralSigningNetwork(network.id, BigInt(network.chainId));
      requireWallet(address.safeParse(accountAddress).success && !/^0x0{40}$/.test(accountAddress),
        "SIGNING_CONTINUITY_UNKNOWN", "The account identity is invalid.");
      const idValue = streamId(this.registry.domainId, accountAddress, networkId);
      if (this.registry.streams.some((stream) => stream.id === idValue)) return;
      requireWallet(await this.isFreshSource(accountAddress, networkId) === true,
        "SIGNING_CONTINUITY_UNKNOWN", "Fresh signing provenance is required.");
      await this.checkRegistry();
      requireWallet(this.registry.streams.length < 3584 && this.repository.read(idValue).length === 0,
        "SIGNING_CONTINUITY_CONFLICT", "A new stream cannot replace existing signing history.");
      const next = structuredClone(this.registry);
      next.streams.push({ id: idValue, accountAddress, networkId, sequence: 0, headDigest: genesis(idValue) });
      try { await writeRegistry(this.protection, next); this.registry = next; this.assertAvailable(); }
      catch { this.broken = true; fail(); }
    });
  }
  /** The sole owner reserves one unsigned nonce per stream; this does not authorize signing. */
  async reserveNonce(accountAddress: string, networkId: string, pendingEvidence: object): Promise<{ nonce: number; reservation: object }> {
    return await this.exclusive(async () => {
      await this.checkRegistry();
      const network = generalNetwork(networkId);
      assertGeneralSigningNetwork(network.id, BigInt(network.chainId));
      requireWallet(address.safeParse(accountAddress).success,
        "SIGNING_CONTINUITY_UNKNOWN", "The pending nonce is unavailable.");
      const stream = this.registry.streams.find((item) => item.accountAddress === accountAddress && item.networkId === networkId);
      requireWallet(stream, "SIGNING_CONTINUITY_UNKNOWN", "The signing stream is not registered.");
      const { events, active } = parseEvents(stream, this.repository.read(stream.id));
      requireWallet(events.length === stream.sequence && (events.at(-1)?.digest ?? genesis(stream.id)) === stream.headDigest,
        "SIGNING_CONTINUITY_CONFLICT", "The signing journal is not current.");
      // Terminal chain-effect evidence is not implemented yet: never infer it from pending nonce alone.
      requireWallet(active.size === 0, "SIGNING_CONTINUITY_UNKNOWN", "An earlier signing risk requires reconciliation.");
      return this.unsigned.reserve(stream.id, accountAddress, networkId, pendingEvidence, this.now());
    });
  }
  /** Cancellation only releases an unsigned reservation, never an appended signing risk. */
  async cancelUnsigned(reservation: object): Promise<void> {
    return await this.exclusive(async () => {
      await this.checkRegistry();
      this.unsigned.cancel(reservation);
    });
  }
  /** The second pending-nonce evidence must be freshly obtained by the trusted owner. */
  async recordSigningPossible(input: GeneralSigningRisk, reservation: object, pendingEvidence: object, fundsEvidence: object, approval: object, simulation: object = {}, intent: object = {}): Promise<object> {
    return await this.exclusive(async () => {
      await this.checkRegistry();
      const risk = parseGeneralSigningRisk(input);
      const now = this.now();
      requireWallet(Number.isSafeInteger(now) && now >= 0 && now <= Number.MAX_SAFE_INTEGER - 60000 &&
        risk.approvalExpiresAt > now && risk.approvalExpiresAt <= now + 60000,
      "TRANSFER_APPROVAL_EXPIRED", "The transfer approval is invalid or expired.");
      const stream = this.registry.streams.find((item) => item.accountAddress === risk.accountAddress && item.networkId === risk.networkId);
      requireWallet(stream, "SIGNING_CONTINUITY_UNKNOWN", "The signing stream is not registered.");
      const proof = await this.unsigned.assert(stream.id, reservation, pendingEvidence, fundsEvidence, approval, simulation, intent, this.protection, this.registry.ownerId, risk, now); this.assertAvailable();
      requireWallet(generalEvidenceIsLive(proof, this.now()), "SIGNING_CONTINUITY_UNKNOWN", "Transfer evidence expired before risk publication.");
      const { events, active } = parseEvents(stream, this.repository.read(stream.id));
      requireWallet(events.length === stream.sequence && (events.at(-1)?.digest ?? genesis(stream.id)) === stream.headDigest,
        "SIGNING_CONTINUITY_CONFLICT", "The signing journal is not current.");
      requireWallet(!active.has(risk.riskId) && ![...active.values()].some((item) => item.transferId === risk.transferId || item.nonce === risk.nonce),
        "SIGNING_CONTINUITY_CONFLICT", "The signing risk is already present.");
      requireWallet(active.size === 0, "SIGNING_CONTINUITY_UNKNOWN", "An earlier signing risk requires reconciliation.");
      let activeCount = 0;
      for (const item of this.registry.streams) {
        const checked = item.id === stream.id ? { events, active } : parseEvents(item, this.repository.read(item.id));
        requireWallet(checked.events.length === item.sequence && (checked.events.at(-1)?.digest ?? genesis(item.id)) === item.headDigest,
          "SIGNING_CONTINUITY_CONFLICT", "A signing stream is not current.");
        activeCount += checked.active.size;
        requireWallet(![...checked.active.values()].some((value) => value.riskId === risk.riskId || value.transferId === risk.transferId),
          "SIGNING_CONTINUITY_CONFLICT", "The signing risk is already present.");
      }
      requireWallet(activeCount < MAX_ACTIVE, "SIGNING_JOURNAL_CAPACITY_REACHED", "The signing journal is full.");
      this.unsigned.take(stream.id, reservation);
      await this.append(stream, risk, "SIGNING_POSSIBLE");
      this.assertAvailable();
      const ticket = Object.freeze({});
      this.tickets.set(ticket, { risk, proof }); this.started.set(risk.riskId, "pending");
      return ticket;
    });
  }
  /** Consuming a ticket proves an appended risk, not authentication or a valid signer. */
  async consumeSigningTicket(ticket: object, riskId: string, intentDigest: string): Promise<object> {
    return await this.exclusive(async () => {
      await this.checkRegistry();
      const capability = ticket && typeof ticket === "object" ? this.tickets.get(ticket) : undefined;
      requireWallet(capability && capability.risk.riskId === riskId && capability.risk.intentDigest === intentDigest,
        "SIGNING_CONTINUITY_UNKNOWN", "The signing capability is invalid.");
      const network = generalNetwork(capability.risk.networkId);
      assertGeneralSigningNetwork(network.id, BigInt(network.chainId));
      const stream = this.registry.streams.find((item) => item.accountAddress === capability.risk.accountAddress && item.networkId === network.id);
      requireWallet(stream, "SIGNING_CONTINUITY_UNKNOWN", "The signing stream is unavailable.");
      const { events, active } = parseEvents(stream, this.repository.read(stream.id));
      requireWallet(events.length === stream.sequence && (events.at(-1)?.digest ?? genesis(stream.id)) === stream.headDigest &&
        active.has(riskId), "SIGNING_CONTINUITY_CONFLICT", "The signing risk is not durable.");
      const now = this.now();
      if (!Number.isSafeInteger(now) || now < 0 || now >= capability.risk.approvalExpiresAt) {
        this.tickets.delete(ticket);
        throw new WalletError("TRANSFER_APPROVAL_EXPIRED", "The transfer approval has expired.");
      }
      if (!generalEvidenceIsLive(capability.proof, now)) { this.tickets.delete(ticket); fail(); }
      this.tickets.delete(ticket);
      this.started.set(riskId, { digest: intentDigest, proof: capability.proof });
      return issueGeneralSignerPermit(this.registry.ownerId, capability.risk, () => !this.closed && !this.broken && this.ownerIsLive(), capability.proof, this.now);
    });
  }
  async recordSigned(riskId: string, transactionHash: string, materialProof: object): Promise<object | null> {
    return await this.exclusive(async () => {
      await this.checkRegistry();
      requireWallet(id.safeParse(riskId).success && /^0x[0-9a-f]{64}$/.test(transactionHash),
        "SIGNING_CONTINUITY_UNKNOWN", "The signed transaction identity is invalid.");
      for (const stream of this.registry.streams) {
        const { events, active } = parseEvents(stream, this.repository.read(stream.id));
        requireWallet(events.length === stream.sequence && (events.at(-1)?.digest ?? genesis(stream.id)) === stream.headDigest,
          "SIGNING_CONTINUITY_CONFLICT", "The signing journal is not current.");
        const risk = active.get(riskId);
        if (!risk) continue;
        const attempt = this.started.get(riskId); requireWallet(!attempt || attempt !== "pending" && attempt.digest === risk.intentDigest, "SIGNING_CONTINUITY_UNKNOWN", "A matching signing attempt is required.");
        await consumeGeneralSignedMaterialProof(materialProof, this.protection, this.registry.ownerId, risk, transactionHash); this.assertAvailable();
        const signed = events.find((event) => event.risk.riskId === riskId && event.phase === "SIGNED");
        if (signed) {
          requireWallet(signed.transactionHash === transactionHash, "SIGNING_CONTINUITY_CONFLICT", "The signing result cannot be replaced.");
          return null;
        }
        await this.append(stream, risk, "SIGNED", transactionHash);
        this.assertAvailable();
        return attempt ? issueGeneralBroadcastPermit(this.registry.ownerId, risk, transactionHash, () => !this.closed && !this.broken && this.ownerIsLive() && generalEvidenceIsLive(attempt.proof, this.now()), this.now) : null;
      }
      fail();
    });
  }
  /** Unknown or signed transactions remain reserved until a separate verified chain finality policy exists. */
  async riskSnapshot(accountAddress: string, networkId: string, asset: "native" | `erc20:0x${string}`): Promise<{
    assetRiskAtomic: string; nativeRiskAtomic: string; riskCount: number;
  }> {
    return await this.exclusive(async () => {
      requireWallet(asset === "native" || /^erc20:0x[0-9a-f]{40}$/.test(asset), "SIGNING_CONTINUITY_UNKNOWN", "The signing risk identity is invalid.");
      const { active } = await this.riskStream(accountAddress, networkId);
      return sumGeneralSigningRisk(active, asset);
    });
  }
  async listPendingRisks(accountAddress: string, networkId: string, offset: number, limit: number, expectedHead?: string): Promise<ReturnType<typeof pageGeneralSigningRisks>> {
    return await this.exclusive(async () => { const { events, active, head } = await this.riskStream(accountAddress, networkId);
      return pageGeneralSigningRisks(events, active, head, offset, limit, expectedHead); });
  }
  /** Absence is display metadata only, never permission to create an empty signing stream. */
  async hasRegisteredStream(accountAddress: string, networkId: string): Promise<boolean> {
    return this.exclusive(async () => {
      await this.checkRegistry(); generalNetwork(networkId);
      requireWallet(address.safeParse(accountAddress).success, "SIGNING_CONTINUITY_UNKNOWN", "The signing stream identity is invalid.");
      assertGeneralSigningInventory(this.registry.streams, this.repository.listStreams());
      return this.registry.streams.some((stream) => stream.accountAddress === accountAddress && stream.networkId === networkId);
    });
  }
  /** A point-in-time component only; never a proof that a backup is complete or current. */
  async checkpointForBackup(): Promise<GeneralSigningCheckpoint> { return await this.exclusive(async () => {
      await this.checkRegistry(); const result = buildGeneralSigningCheckpoint(this.registry, this.repository, (stream, raw) => {
        const { events } = parseEvents(stream, raw);
        requireWallet(events.length === stream.sequence && (events.at(-1)?.digest ?? genesis(stream.id)) === stream.headDigest,
          "SIGNING_CONTINUITY_CONFLICT", "The signing journal is not current."); return events;
      });
      await this.checkRegistry(); return result;
    }, true); }
  private async riskStream(accountAddress: string, networkId: string): Promise<{ events: GeneralSigningEvent[]; active: Map<string, GeneralSigningRisk>; head: string }> {
    await this.checkRegistry(); const network = generalNetwork(networkId); assertGeneralSigningNetwork(network.id, BigInt(network.chainId));
    requireWallet(address.safeParse(accountAddress).success, "SIGNING_CONTINUITY_UNKNOWN", "The signing risk identity is invalid.");
    const stream = this.registry.streams.find((item) => item.accountAddress === accountAddress && item.networkId === networkId);
    requireWallet(stream, "SIGNING_CONTINUITY_UNKNOWN", "The signing stream is not registered.");
    const { events, active } = parseEvents(stream, this.repository.read(stream.id));
    requireWallet(events.length === stream.sequence && (events.at(-1)?.digest ?? genesis(stream.id)) === stream.headDigest,
      "SIGNING_CONTINUITY_CONFLICT", "The signing journal is not current.");
    return { events, active, head: stream.headDigest };
  }
  private async append(stream: Stream, risk: GeneralSigningRisk, phase: "SIGNING_POSSIBLE" | "SIGNED", transactionHash?: string): Promise<void> {
    const body = { version: 1 as const, streamId: stream.id, sequence: stream.sequence + 1, previousDigest: stream.headDigest,
      phase, risk, ...(transactionHash ? { transactionHash } : {}) };
    const event = { ...body, digest: digest(body) };
    requireWallet(this.repository.byteSize() + Buffer.byteLength(canonical(event)) <= MAX_JOURNAL,
      "SIGNING_JOURNAL_CAPACITY_REACHED", "The signing journal is full.");
    try {
      this.repository.append(event, stream.sequence, stream.headDigest);
      const next = structuredClone(this.registry), nextStream = next.streams.find((item) => item.id === stream.id)!;
      nextStream.sequence = event.sequence; nextStream.headDigest = event.digest;
      await writeRegistry(this.protection, next);
      this.registry = next;
    } catch { this.broken = true; fail(); }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsigned.clear();
    await this.queue;
    this.repository.close();
  }
}
