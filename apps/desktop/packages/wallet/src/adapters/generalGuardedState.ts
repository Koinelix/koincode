import { types } from "node:util";
import { assertGeneralStateAdvance, assertGeneralStateForward, validateGeneralLegacyState, validateGeneralState, type GeneralWalletState } from "../app/generalState.js";
import type { ProtectedStore } from "../app/ports.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { canonical, digest } from "./canonical.js";

const CHECKPOINT_ACCOUNT = "general-state-v1";
const MAX_CHECKPOINT_BYTES = 512 * 1024;
type FreshSigningLease = { installationId: string; initialDomainId?: string; valid: () => boolean; ownerIsLive: () => boolean;
  matchesProtection: (candidate: ProtectedStore) => boolean; release: () => void };
const freshSigningTickets = new WeakMap<object, { ownerId: string; reserve: () => FreshSigningLease | null }>();

/** Consumed only by the isolated signing owner; JSON or renderer objects cannot forge this ticket. */
export function consumeFreshSigningDomainTicket(ticket: object, ownerId: string): FreshSigningLease {
  const value = ticket && typeof ticket === "object" ? freshSigningTickets.get(ticket) : undefined;
  if (ticket && typeof ticket === "object") freshSigningTickets.delete(ticket);
  requireWallet(value && value.ownerId === ownerId, "SIGNING_CONTINUITY_UNKNOWN", "Fresh signing provenance is unavailable.");
  const lease = value.reserve();
  requireWallet(lease, "SIGNING_CONTINUITY_UNKNOWN", "Fresh signing provenance is unavailable.");
  return lease;
}

/** The repository is an isolated SQLite projection; protected storage is the latest authority. */
export interface GeneralStateRepository {
  read(): GeneralWalletState | null;
  write(expected: GeneralWalletState | null, next: GeneralWalletState): void;
  close(): void;
}

function fail(): never { throw new WalletError("GENERAL_STORE_UNAVAILABLE", "The protected general wallet state is unavailable."); }
function encode(state: GeneralWalletState): Uint8Array {
  const text = canonical({ format: "koincode-general-checkpoint", version: 1, digest: digest(state), state });
  requireWallet(Buffer.byteLength(text, "utf8") <= MAX_CHECKPOINT_BYTES,
    "GENERAL_STORE_UNAVAILABLE", "The protected general wallet state exceeds its capacity.");
  return Buffer.from(text, "utf8");
}
async function readProtected(protection: Pick<ProtectedStore, "get">): Promise<GeneralWalletState | null> {
  const bytes = await protection.get(CHECKPOINT_ACCOUNT);
  if (!bytes) return null;
  try {
    if (bytes.byteLength > MAX_CHECKPOINT_BYTES) return fail();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const record: unknown = JSON.parse(text);
    if (!record || typeof record !== "object" || Array.isArray(record)) return fail();
    const value = record as Record<string, unknown>;
    if (Object.keys(value).sort().join() !== "digest,format,state,version" || value.format !== "koincode-general-checkpoint" || value.version !== 1) return fail();
    const state = validateGeneralState(value.state);
    if (value.digest !== digest(state) || canonical(value) !== text) return fail();
    return state;
  } catch { return fail(); }
  finally { bytes.fill(0); }
}

// Shared only by the private restore target adapter; the checkpoint format is unchanged.
export { encode as encodeGeneralStateCheckpoint, readProtected as readGeneralStateCheckpoint };

/** Read-only legacy projection; the caller must hold an exclusive domain lease for the whole inspection. */
export async function inspectLegacyGeneralState(input: { projection: { read(): unknown }; protection: Pick<ProtectedStore, "get">;
  isLive: () => boolean; signal?: AbortSignal }): Promise<{ status: "legacy_policy_unverified"; ownerId: string; installationId: string;
    sources: Array<{ id: string; address: string; sourceType: "mnemonic" | "private_key"; status: "staged" | "ready" }> }> {
  const current = () => requireWallet(!input.signal?.aborted && input.isLive() === true,
    "GENERAL_STORE_UNAVAILABLE", "The legacy wallet inspection is unavailable.");
  const readLegacy = async () => {
    current(); const bytes = await input.protection.get(CHECKPOINT_ACCOUNT);
    if (!bytes) return fail();
    try {
      current();
      requireWallet(bytes.byteLength <= MAX_CHECKPOINT_BYTES, "GENERAL_STORE_UNAVAILABLE", "The legacy checkpoint is invalid.");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes), value: unknown = JSON.parse(text);
      requireWallet(value && typeof value === "object" && !Array.isArray(value), "GENERAL_STORE_UNAVAILABLE", "The legacy checkpoint is invalid.");
      const row = value as Record<string, unknown>;
      requireWallet(Object.keys(row).sort().join() === "digest,format,state,version" && row.format === "koincode-general-checkpoint" &&
        row.version === 1 && canonical(row) === text, "GENERAL_STORE_UNAVAILABLE", "The legacy checkpoint is invalid.");
      const state = validateGeneralLegacyState(row.state);
      requireWallet(row.digest === digest(state), "GENERAL_STORE_UNAVAILABLE", "The legacy checkpoint is invalid.");
      return state;
    } catch { return fail(); } finally { bytes.fill(0); }
  };
  const state = await readLegacy();
  current();
  const projection = validateGeneralLegacyState(input.projection.read());
  requireWallet(digest(projection) === digest(state), "GENERAL_STORE_UNAVAILABLE", "The legacy wallet projection conflicts with its checkpoint.");
  const again = await readLegacy();
  current();
  requireWallet(digest(again) === digest(state) && digest(validateGeneralLegacyState(input.projection.read())) === digest(state),
    "GENERAL_STORE_UNAVAILABLE", "The legacy wallet changed during inspection.");
  current();
  return { status: "legacy_policy_unverified", ownerId: state.ownerId, installationId: state.installationId,
    sources: state.sources.map(({ id, address, sourceType, status }) => ({ id, address, sourceType, status })) };
}

export class GeneralGuardedState {
  private queue: Promise<unknown> = Promise.resolve();
  private pendingMutations = 0;
  private backupSnapshot?: object;
  private signingInitialization = false;
  private signingInitializationClaimed = false;
  private broken = false;
  private closed = false;
  private constructor(private readonly repository: GeneralStateRepository, private readonly protection: ProtectedStore,
    private state: GeneralWalletState) {}

  static async initialize(repository: GeneralStateRepository, protection: ProtectedStore, initial: GeneralWalletState): Promise<GeneralGuardedState> {
    const state = validateGeneralState(initial);
    try {
      requireWallet(state.revision === 0 && state.sources.length === 0 && state.setups.length === 0 &&
        await readProtected(protection) === null && repository.read() === null,
      "GENERAL_STORE_UNAVAILABLE", "Only an explicitly new empty general wallet can be initialized.");
      const bytes = encode(state);
      try { await protection.put(CHECKPOINT_ACCOUNT, bytes); } finally { bytes.fill(0); }
      const checked = await readProtected(protection);
      requireWallet(checked && digest(checked) === digest(state), "GENERAL_STORE_UNAVAILABLE", "The protected state write could not be verified.");
      repository.write(null, state);
      return new GeneralGuardedState(repository, protection, state);
    } catch (error) { repository.close(); throw error; }
  }

  static async open(repository: GeneralStateRepository, protection: ProtectedStore): Promise<GeneralGuardedState> {
    try {
      const authoritative = await readProtected(protection);
      requireWallet(authoritative, "GENERAL_STORE_UNAVAILABLE", "The protected state checkpoint is missing.");
      const projectionRaw = repository.read();
      requireWallet(projectionRaw !== null, "GENERAL_STORE_UNAVAILABLE", "The wallet projection is missing and requires recovery.");
      const projection = validateGeneralState(projectionRaw);
      if (projection.revision === authoritative.revision)
        requireWallet(digest(projection) === digest(authoritative), "GENERAL_STORE_UNAVAILABLE", "The protected state conflicts with its projection.");
      else {
        assertGeneralStateForward(projection, authoritative);
        repository.write(projection, authoritative);
      }
      return new GeneralGuardedState(repository, protection, authoritative);
    } catch (error) { repository.close(); throw error; }
  }

  snapshot(): GeneralWalletState {
    requireWallet(!this.closed && !this.broken, "GENERAL_STORE_UNAVAILABLE", "The protected general wallet state is unavailable.");
    return structuredClone(this.state);
  }

  /** In-process liveness check for the new signing owner; it exposes no secret material. */
  isLive(ownerId: string, installationId: string): boolean {
    return !this.closed && !this.broken && this.state.ownerId === ownerId && this.state.installationId === installationId;
  }

  /** State and signing owners must use the same in-process protected store instance. */
  isBoundTo(protection: ProtectedStore): boolean {
    return !this.closed && !this.broken && this.protection === protection;
  }

  reserveBackupSnapshot(): { isCurrent(): boolean; release(): void } {
    const state = this.snapshot();
    requireWallet(!this.backupSnapshot && this.pendingMutations === 0 && !this.signingInitialization,
      "GENERAL_OPERATION_BUSY", "The general wallet state is busy.");
    const token = Object.freeze({}); this.backupSnapshot = token;
    return { isCurrent: () => this.backupSnapshot === token && this.isLive(state.ownerId, state.installationId),
      release: () => { if (this.backupSnapshot === token) this.backupSnapshot = undefined; } };
  }

  issueFreshSigningDomainTicket(initialDomainId?: string): object {
    requireWallet(initialDomainId === undefined || typeof initialDomainId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(initialDomainId),
      "SIGNING_CONTINUITY_UNKNOWN", "The original initialization domain identity is invalid.");
    const state = this.snapshot();
    requireWallet(!this.backupSnapshot && !this.signingInitializationClaimed && !this.signingInitialization && this.pendingMutations === 0 &&
      state.revision === 0 && state.setups.length === 0 && state.sources.length === 0,
      "SIGNING_CONTINUITY_UNKNOWN", "A signing domain cannot be recreated over wallet history.");
    const ticket = Object.freeze({});
    freshSigningTickets.set(ticket, { ownerId: state.ownerId, reserve: () => {
      const validState = () => !this.closed && !this.broken && !this.backupSnapshot && this.pendingMutations === 0 &&
        this.state.ownerId === state.ownerId && this.state.installationId === state.installationId &&
        this.state.revision === 0 && this.state.setups.length === 0 && this.state.sources.length === 0;
      if (this.signingInitializationClaimed || this.signingInitialization || !validState()) return null;
      this.signingInitialization = true;
      this.signingInitializationClaimed = true;
      let released = false;
      return { installationId: state.installationId, ...(initialDomainId === undefined ? {} : { initialDomainId }), valid: () => !released && this.signingInitialization && validState(),
        ownerIsLive: () => this.isLive(state.ownerId, state.installationId),
        matchesProtection: (candidate: ProtectedStore) => this.isBoundTo(candidate),
        release: () => { if (!released) { released = true; this.signingInitialization = false; } } };
    } });
    return ticket;
  }

  mutate<T>(change: (state: GeneralWalletState) => T): Promise<T> {
    if (this.backupSnapshot) return Promise.reject(new WalletError("GENERAL_OPERATION_BUSY", "A general wallet backup snapshot is active."));
    if (this.signingInitialization) return Promise.reject(new WalletError("GENERAL_OPERATION_BUSY", "General wallet initialization is in progress."));
    this.pendingMutations++;
    const operation = this.queue.then(async () => {
      requireWallet(!this.closed && !this.broken, "GENERAL_STORE_UNAVAILABLE", "The protected general wallet state is unavailable.");
      requireWallet(!types.isAsyncFunction(change), "GENERAL_STORE_UNAVAILABLE", "State changes must be synchronous.");
      const draft = structuredClone(this.state);
      const result = change(draft);
      requireWallet(!(result instanceof Promise), "GENERAL_STORE_UNAVAILABLE", "State changes must be synchronous.");
      draft.revision = this.state.revision + 1;
      const next = validateGeneralState(draft);
      assertGeneralStateAdvance(this.state, next);
      const detached = structuredClone(result);
      const bytes = encode(next);
      try {
        await this.protection.put(CHECKPOINT_ACCOUNT, bytes);
        const checked = await readProtected(this.protection);
        requireWallet(checked && digest(checked) === digest(next), "GENERAL_STORE_UNAVAILABLE", "The protected state write could not be verified.");
        this.repository.write(this.state, next);
        this.state = next;
        return detached;
      } catch {
        this.broken = true;
        return fail();
      } finally { bytes.fill(0); }
    }).finally(() => { this.pendingMutations--; });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    this.repository.close();
  }
}
