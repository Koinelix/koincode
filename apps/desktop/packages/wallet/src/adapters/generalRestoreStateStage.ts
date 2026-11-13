import type { ProtectedStore } from "../app/ports.js";
import { validateGeneralState, type GeneralWalletState } from "../app/generalState.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { canonical } from "./canonical.js";
import { encodeGeneralStateCheckpoint, readGeneralStateCheckpoint, type GeneralStateRepository } from "./generalGuardedState.js";
import { validateGeneralRestorePlan, type GeneralRestorePlan } from "./generalRestorePlan.js";

type Protection = Pick<ProtectedStore, "get">;
type Connection = { owner?: object; uncertain?: boolean };
type NativeStage = (input: Readonly<{ canonicalPlan: string; canonicalCheckpoint: string }>, signal?: AbortSignal) => Promise<void>;
const connections = new WeakMap<Protection, Connection>();
const repositories = new WeakMap<GeneralStateRepository, object>();
const canceled = () => new WalletError("GENERAL_RECOVERY_OPERATION_CANCELED", "The original restore target operation ended.");
const conflict = () => new WalletError("GENERAL_RECOVERY_RECORD_CONFLICT", "The original restore target could not be verified.");
const uncertain = () => new WalletError("GENERAL_RECOVERY_WRITE_UNCERTAIN", "The original restore target requires inspection before further writes.");

/** Coordinates one target projection, never a runtime or native permission. The backend must be a genuine scoped staging view. */
export class GeneralRestoreStateStage {
  private readonly plan: GeneralRestorePlan;
  private readonly token = Object.freeze({});
  private readonly connection: Connection;
  private readonly prepareCheckpoint: NativeStage;
  private readonly readPlan: () => Promise<GeneralRestorePlan | null>;
  private readonly isCurrent: () => boolean;
  private readonly abort = new AbortController();
  private active?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  constructor(private readonly repository: GeneralStateRepository, private readonly protection: Protection,
    input: GeneralRestorePlan, ports: { readPlan(): Promise<GeneralRestorePlan | null>; isCurrent(): boolean; prepareCheckpoint: NativeStage }) {
    this.plan = validateGeneralRestorePlan(input);
    requireWallet(typeof ports?.readPlan === "function" && typeof ports.isCurrent === "function" && typeof ports.prepareCheckpoint === "function",
      "GENERAL_RECOVERY_STORE_UNAVAILABLE", "The native restore target port is unavailable.");
    this.readPlan = ports.readPlan.bind(ports); this.isCurrent = ports.isCurrent.bind(ports);
    this.prepareCheckpoint = ports.prepareCheckpoint.bind(ports);
    this.connection = connections.get(protection) ?? {};
    requireWallet(!this.connection.owner && !repositories.has(repository), "GENERAL_OPERATION_BUSY", "The restore target already has an owner.");
    this.connection.owner = this.token; connections.set(protection, this.connection); repositories.set(repository, this.token);
  }

  /** Only the original keys-staged operation may prepare missing target resources. No phase is advanced here. */
  async stage(signal?: AbortSignal): Promise<void> {
    return this.run(signal, async (currentSignal) => {
      if (this.connection.uncertain) throw uncertain();
      const plan = await this.currentPlan(currentSignal);
      const before = await this.readPair(currentSignal);
      this.matches(before.checkpoint, true); this.matches(before.projection, true);
      if (before.checkpoint && before.projection) { await this.currentPlan(currentSignal); return; }
      requireWallet(plan.phase === "keys_staged" && before.projection === null,
        "GENERAL_RECOVERY_RECORD_CONFLICT", "Missing restore targets cannot be recreated at this phase.");
      const bytes = encodeGeneralStateCheckpoint(this.plan.target.state);
      try {
        this.check(currentSignal);
        let failed = false;
        try {
          const result: unknown = await this.prepareCheckpoint(Object.freeze({ canonicalPlan: canonical(plan),
            canonicalCheckpoint: Buffer.from(bytes).toString("utf8") }), currentSignal);
          if (result !== undefined) failed = true;
        } catch { failed = true; }
        // Drain the admitted native command and inspect its exact metadata even after cancellation or lost acknowledgment.
        try { this.matches(await readGeneralStateCheckpoint(this.protection), false); } catch { failed = true; }
        if (failed) { this.connection.uncertain = true; throw uncertain(); }
      } finally { bytes.fill(0); }
      this.check(currentSignal);
      const again = await this.currentPlan(currentSignal);
      requireWallet(again.phase === "keys_staged", "GENERAL_RECOVERY_RECORD_CONFLICT", "The original restore phase changed.");
      this.check(currentSignal);
      try {
        const projection = this.repository.read(); this.matches(projection, true);
        // An exact already-written projection is inspected, never rewritten.
        if (projection === null) this.repository.write(null, structuredClone(this.plan.target.state));
        this.matches(this.repository.read(), false);
        this.matches(await readGeneralStateCheckpoint(this.protection), false);
      } catch { this.connection.uncertain = true; throw uncertain(); }
      this.check(currentSignal);
      await this.currentPlan(currentSignal);
    });
  }

  /** Read-only inspection is allowed on an uncertain connection; missing resources remain an error. */
  async inspect(signal?: AbortSignal): Promise<void> {
    return this.run(signal, async (currentSignal) => {
      await this.currentPlan(currentSignal);
      const pair = await this.readPair(currentSignal);
      this.matches(pair.checkpoint, false); this.matches(pair.projection, false);
      await this.currentPlan(currentSignal);
    });
  }

  private matches(input: GeneralWalletState | null, allowMissing: boolean): void {
    if (input === null && allowMissing) return;
    if (input === null || canonical(validateGeneralState(input)) !== canonical(this.plan.target.state)) throw conflict();
  }
  private async readPair(signal: AbortSignal) {
    this.check(signal);
    const checkpoint = await readGeneralStateCheckpoint(this.protection); this.check(signal);
    const projection = this.repository.read(); this.check(signal);
    return { checkpoint, projection };
  }
  private async currentPlan(signal: AbortSignal): Promise<GeneralRestorePlan> {
    this.check(signal);
    const value = await this.readPlan(); this.check(signal);
    requireWallet(value !== null, "GENERAL_RECOVERY_RECORD_CONFLICT", "The original protected restore plan is missing.");
    const plan = validateGeneralRestorePlan(value);
    requireWallet(canonical({ ...plan, phase: this.plan.phase }) === canonical(this.plan) && plan.phase !== "prepared",
      "GENERAL_RECOVERY_RECORD_CONFLICT", "The original staged restore plan is required.");
    return plan;
  }
  private check(signal: AbortSignal): void {
    if (this.closed || signal.aborted) throw canceled();
    let current = false;
    try { current = this.isCurrent() === true; } catch { /* Failed native lifetime checks grant no target access. */ }
    requireWallet(current && this.connection.owner === this.token,
      "GENERAL_RECOVERY_STORE_UNAVAILABLE", "The native restore target lifetime is unavailable.");
  }
  private async run(signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const combined = signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal;
    this.check(combined);
    requireWallet(!this.active, "GENERAL_OPERATION_BUSY", "A restore target command is already running.");
    let finish!: () => void;
    const active = new Promise<void>((resolve) => { finish = resolve; }); this.active = active;
    try { await work(combined); this.check(combined); }
    catch (error) {
      if (error instanceof WalletError) throw error;
      throw new WalletError("GENERAL_RECOVERY_STORE_UNAVAILABLE", "The protected restore target is unavailable.");
    } finally { if (this.active === active) this.active = undefined; finish(); }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.abort.abort();
    this.closing = (async () => {
      await this.active;
      try { this.repository.close(); }
      catch {
        this.connection.uncertain = true;
        throw new WalletError("GENERAL_RECOVERY_STORE_UNAVAILABLE", "The restore target repository did not close safely.");
      }
      if (this.connection.owner === this.token) this.connection.owner = undefined;
      if (repositories.get(this.repository) === this.token) repositories.delete(this.repository);
    })();
    return this.closing;
  }
}
