import { validateGeneralState, type GeneralWalletState } from "../app/generalState.js";
import type { GeneralSigningEvent, GeneralSigningJournalRepository } from "./generalSigningJournal.js";
import type { GeneralStateRepository } from "./generalGuardedState.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { canonical, digest } from "./canonical.js";

export type GeneralProtectedRecipe = "begin" | "commit" | "rollback" | "state_read" | "state_write" | "streams" | "events" | "sizes" | "previous" | "count" | "append" | "version";
type Row = Readonly<Record<string, string | number>>;
/** Private native-factory port, never an SDK, renderer object or admission proof.
 * Only the genuine sealed bridge creates its C-wrapped pair/recipe owner.
 * No arbitrary SQL, caller path, descriptor or create flag crosses this port. */
export interface GeneralProtectedSqlPort {
  readonly kind: "state" | "signing";
  assertCurrent(): void;
  execute(recipe: GeneralProtectedRecipe, parameters: readonly (string | number)[]): {
    status: "ok" | "rejected" | "busy" | "uncertain"; rows: readonly Row[]; changes: number;
  };
  close(): "closed" | "busy" | "uncertain";
}
class NativeRecipes {
  private active = false;
  private closing = false;
  private closed = false;
  private uncertain = false;
  constructor(private readonly port: GeneralProtectedSqlPort, private readonly code: string, kind: "state" | "signing") {
    requireWallet(port?.kind === kind, code, "The native repository kind does not match.");
  }
  private fail(): never { throw new WalletError(this.code, "The protected repository is unavailable."); }
  private current(): void {
    if (this.closed || this.closing || this.uncertain) this.fail();
    let result: unknown;
    try { result = this.port.assertCurrent(); }
    catch { this.uncertain = true; this.fail(); }
    if (result !== undefined) {
      if (result instanceof Promise) void result.catch(() => {});
      this.uncertain = true; this.fail();
    }
  }
  call(recipe: GeneralProtectedRecipe, parameters: readonly (string | number)[] = []): readonly Row[] {
    this.current();
    let result: ReturnType<GeneralProtectedSqlPort["execute"]>;
    try { result = this.port.execute(recipe, parameters); }
    catch { this.uncertain = true; this.fail(); }
    if (result?.status === "uncertain" || !["ok", "rejected", "busy"].includes(result?.status)) { this.uncertain = true; this.fail(); }
    if (result.status === "busy") throw new WalletError("GENERAL_OPERATION_BUSY", "The original native repository is busy.");
    if (result.status !== "ok") this.fail();
    if (!Array.isArray(result.rows) || !Number.isSafeInteger(result.changes) || result.changes < 0) { this.uncertain = true; this.fail(); }
    this.current(); return result.rows;
  }
  run<T>(work: () => T): T {
    requireWallet(!this.active, "GENERAL_OPERATION_BUSY", "The native repository already has pending work.");
    this.active = true;
    try { this.current(); return work(); }
    finally { this.active = false; }
  }
  transaction(work: () => void): void {
    this.call("begin");
    try { work(); this.call("commit"); }
    catch (error) {
      if (!this.uncertain) { try { this.call("rollback"); } catch { this.uncertain = true; } }
      throw error;
    }
  }
  close(): void {
    if (this.closed) return;
    requireWallet(!this.active, "GENERAL_OPERATION_BUSY", "The original native operation has not drained.");
    if (this.uncertain) this.fail();
    this.closing = true;
    let result: ReturnType<GeneralProtectedSqlPort["close"]>;
    try { result = this.port.close(); } catch { this.uncertain = true; this.fail(); }
    if (result === "closed") { this.closed = true; return; }
    if (result === "busy") throw new WalletError("GENERAL_OPERATION_BUSY", "The original native repository has not drained.");
    this.uncertain = true; this.fail();
  }
}
/** Same guarded-state projection contract; this adapter owns no accepted state. */
export class ProtectedGeneralStateRepository implements GeneralStateRepository {
  private readonly native: NativeRecipes;
  constructor(port: GeneralProtectedSqlPort) { this.native = new NativeRecipes(port, "GENERAL_STORE_UNAVAILABLE", "state"); }
  private readRows(): GeneralWalletState | null {
    const rows = this.native.call("state_read");
    requireWallet(rows.length <= 1, "GENERAL_STORE_UNAVAILABLE", "The protected state projection is invalid.");
    if (!rows.length) return null;
    const row = rows[0]!;
    try {
      requireWallet(typeof row.state_json === "string" && Buffer.byteLength(row.state_json) <= 512 * 1024,
        "GENERAL_STORE_UNAVAILABLE", "The protected state projection is invalid.");
      const parsed: unknown = JSON.parse(row.state_json), value = validateGeneralState(parsed);
      requireWallet(canonical(parsed) === row.state_json && Number.isSafeInteger(row.revision) && row.revision === value.revision,
        "GENERAL_STORE_UNAVAILABLE", "The protected state revision is invalid.");
      return value;
    } catch { throw new WalletError("GENERAL_STORE_UNAVAILABLE", "The protected state projection is invalid."); }
  }
  read(): GeneralWalletState | null { return this.native.run(() => this.readRows()); }
  write(expected: GeneralWalletState | null, next: GeneralWalletState): void {
    const expectedDigest = expected === null ? null : digest(validateGeneralState(expected));
    const value = validateGeneralState(next), serialized = canonical(value);
    requireWallet(Buffer.byteLength(serialized) <= 512 * 1024, "GENERAL_STORE_UNAVAILABLE", "The protected state projection exceeds its capacity.");
    this.native.run(() => this.native.transaction(() => {
      const current = this.readRows();
      requireWallet(expectedDigest === null ? current === null : current !== null && digest(current) === expectedDigest,
        "GENERAL_STORE_UNAVAILABLE", "The protected state projection changed unexpectedly.");
      this.native.call("state_write", [value.revision, serialized]);
    }));
  }
  close(): void { this.native.close(); }
}
/** Uses the original journal owner and event format through fixed native recipes. */
export class ProtectedGeneralSigningJournalRepository implements GeneralSigningJournalRepository {
  private readonly native: NativeRecipes;
  constructor(port: GeneralProtectedSqlPort) { this.native = new NativeRecipes(port, "SIGNING_CONTINUITY_UNKNOWN", "signing"); }
  listStreams(): string[] {
    return this.native.run(() => {
      const rows = this.native.call("streams");
      requireWallet(rows.length <= 3584 && rows.every((row) => typeof row.stream_id === "string" && /^[0-9a-f]{64}$/.test(row.stream_id)),
        "SIGNING_CONTINUITY_CONFLICT", "The signing journal contains invalid streams.");
      return rows.map((row) => row.stream_id as string);
    });
  }
  read(streamId: string): GeneralSigningEvent[] {
    requireWallet(/^[0-9a-f]{64}$/.test(streamId), "SIGNING_CONTINUITY_UNKNOWN", "The signing stream is invalid.");
    return this.native.run(() => {
      const rows = this.native.call("events", [streamId, 2001]);
      requireWallet(rows.length <= 2000, "SIGNING_JOURNAL_CAPACITY_REACHED", "The signing journal is full.");
      return rows.map((row) => {
        try {
          requireWallet(typeof row.event_json === "string" && Buffer.byteLength(row.event_json) <= 8192,
            "SIGNING_CONTINUITY_CONFLICT", "The signing event is invalid.");
          const event = JSON.parse(row.event_json) as GeneralSigningEvent;
          requireWallet(event && canonical(event) === row.event_json && event.streamId === streamId && Number.isSafeInteger(row.sequence) &&
            event.sequence === row.sequence && event.digest === row.event_digest, "SIGNING_CONTINUITY_CONFLICT", "The signing event is invalid.");
          return event;
        } catch { throw new WalletError("SIGNING_CONTINUITY_CONFLICT", "The signing event is invalid."); }
      });
    });
  }
  private size(): number {
    const rows = this.native.call("sizes"), row = rows[0];
    requireWallet(rows.length === 1 && row && Number.isSafeInteger(row.count) && Number.isSafeInteger(row.bytes) &&
      Number(row.count) >= 0 && Number(row.count) <= 2000 && Number(row.bytes) >= 0 && Number(row.bytes) <= 32 * 1024 * 1024,
      "SIGNING_JOURNAL_CAPACITY_REACHED", "The signing journal is full.");
    return Number(row.bytes);
  }
  byteSize(): number { return this.native.run(() => this.size()); }
  append(event: GeneralSigningEvent, previousSequence: number, previousDigest: string): void {
    const frozen = structuredClone(event), json = canonical(frozen);
    requireWallet(/^[0-9a-f]{64}$/.test(frozen.streamId) && /^[0-9a-f]{64}$/.test(frozen.digest) && Number.isSafeInteger(previousSequence) &&
      previousSequence >= 0 && Number.isSafeInteger(frozen.sequence) && frozen.sequence === previousSequence + 1 && frozen.previousDigest === previousDigest && Buffer.byteLength(json) <= 8192,
      "SIGNING_CONTINUITY_CONFLICT", "The signing event is invalid.");
    this.native.run(() => this.native.transaction(() => {
      const previous = this.native.call("previous", [frozen.streamId]);
      requireWallet(previous.length <= 1 && (previousSequence === 0 ? previous.length === 0 :
        previous[0]?.sequence === previousSequence && previous[0]?.event_digest === previousDigest),
        "SIGNING_CONTINUITY_CONFLICT", "The signing stream changed unexpectedly.");
      const count = this.native.call("count");
      requireWallet(count.length === 1 && Number.isSafeInteger(count[0]?.n) && Number(count[0]?.n) >= 0 && Number(count[0]?.n) < 2000 &&
        this.size() + Buffer.byteLength(json) <= 32 * 1024 * 1024, "SIGNING_JOURNAL_CAPACITY_REACHED", "The signing journal is full.");
      this.native.call("append", [frozen.streamId, frozen.sequence, frozen.digest, json]);
    }));
  }
  close(): void { this.native.close(); }
}
