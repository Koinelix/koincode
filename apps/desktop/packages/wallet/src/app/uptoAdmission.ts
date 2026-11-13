import { AllowanceWait } from "./uptoPreparation.js";
import { WalletError, requireWallet } from "../domain/errors.js";

/** Shared holders sign side by side; an exclusive holder is alone on its subject. */
export type AdmissionMode = "shared" | "exclusive";
type Grant = (mode: AdmissionMode, directAmount?: bigint) => boolean;
interface Slot { exclusive?: { owner: string; expires: number }; shared: Map<string, number>; line: string[]; proofWrites: string[]; wakers: Set<() => void> }

/** Short-lived admission leases are not financial reservations and are never replayed after restart. */
export class UptoAdmission {
  private readonly slots = new Map<string, Slot>();
  private readonly waiting = new Map<string, { expires: number; lifetime: AbortController }>();
  private readonly spare = new Map<string, bigint>();
  private proofWaiters = 0;
  isWaiting(owner: string): boolean { const wait = this.waiting.get(owner); return wait !== undefined && wait.expires > this.now(); }
  owns(subjectId: string, owner: string): boolean { return this.waiting.has(owner) || this.mode(subjectId, owner) !== undefined; }
  constructor(private readonly now: () => number, private readonly delay: (ms: number, signal: AbortSignal) => Promise<void>) {}
  private slot(subjectId: string): Slot {
    let slot = this.slots.get(subjectId);
    if (!slot) this.slots.set(subjectId, slot = { shared: new Map(), line: [], proofWrites: [], wakers: new Set() });
    if (slot.exclusive && slot.exclusive.expires <= this.now()) delete slot.exclusive;
    for (const [owner, expires] of slot.shared) if (expires <= this.now()) slot.shared.delete(owner);
    return slot;
  }
  private wake(slot: Slot): void { for (const wake of slot.wakers) wake(); }
  capacityChanged(subjectId: string): void {
    const slot = this.slots.get(subjectId);
    if (slot) this.wake(slot);
  }
  private leave(subjectId: string, owner: string): void {
    const slot = this.slot(subjectId);
    for (const line of [slot.line, slot.proofWrites]) {
      const index = line.indexOf(owner);
      if (index >= 0) line.splice(index, 1);
    }
    this.wake(slot);
    if (!slot.exclusive && !slot.shared.size && !slot.line.length && !slot.proofWrites.length && !slot.wakers.size) this.slots.delete(subjectId);
  }
  /** Unexpired shared holders other than `owner`, whose reservations may not be in the ledger yet. */
  sharedOwners(subjectId: string, owner?: string): string[] {
    return [...this.slot(subjectId).shared.keys()].filter(item => item !== owner);
  }
  mode(subjectId: string, owner: string): AdmissionMode | undefined {
    const slot = this.slot(subjectId);
    return slot.exclusive?.owner === owner ? "exclusive" : slot.shared.has(owner) ? "shared" : undefined;
  }
  /**
   * `ready` decides and calls `grant` in one synchronous step, so two checks never admit against the same
   * observation. A check that returns true without calling it asks for exclusive admission.
   */
  async acquire(subjectId: string, owner: string, signal: AbortSignal,
    ready: (signal: AbortSignal, grant: Grant) => Promise<boolean | "recheck">, onWait?: (duration: number) => void,
    kind: "payment" | "proof_write" = "payment", quoteAmount?: bigint): Promise<{ waited: boolean }> {
    const proof = kind === "proof_write";
    // The recovery worker has four full and eight follow-up jobs. A full unsigned queue cannot lock them out.
    const hasCapacity = proof ? this.proofWaiters < 12 : this.waiting.size - this.proofWaiters < 32;
    requireWallet(!this.waiting.has(owner) && this.mode(subjectId, owner) === undefined && hasCapacity,
      "PAYMENT_QUEUE_FULL", "The payment waiting queue is full or duplicated.");
    const wait = { expires: Number.NEGATIVE_INFINITY, lifetime: new AbortController() };
    this.waiting.set(owner, wait);
    if (proof) {
      this.proofWaiters++;
      this.slot(subjectId).proofWrites.push(owner);
    }
    const turn = (slot: Slot) => {
      const first = slot.proofWrites[0] ?? slot.line[0];
      return first === undefined || first === owner;
    };
    const predecessors = (slot: Slot) => {
      const position = slot.line.indexOf(owner);
      return position < 0 ? slot.line : slot.line.slice(0, position);
    };
    const fitsBesideWaiters = (slot: Slot, amount?: bigint) => !slot.proofWrites.length &&
      amount !== undefined && amount > 0n && predecessors(slot).every(peer => (this.spare.get(peer) ?? 0n) >= amount);
    const expires = this.now() + 1200000;
    const timeout = new WalletError("PAYMENT_QUEUE_TIMEOUT", "The previous payment did not become ready within the waiting limit.");
    const timer = setTimeout(() => wait.lifetime.abort(timeout), 1_200_000);
    timer.unref();
    const active = AbortSignal.any([signal, wait.lifetime.signal]);
    const checkTime = () => {
      active.throwIfAborted();
      if (this.now() >= expires) throw timeout;
    };
    const grant: Grant = (mode, directAmount) => {
      checkTime();
      const slot = this.slot(subjectId);
      // A protected reader already has its turn. Promote only when it is the sole holder.
      if (slot.shared.has(owner)) {
        if (mode === "shared") return true;
        if (slot.shared.size !== 1) return false;
        slot.shared.delete(owner);
        slot.exclusive = { owner, expires };
        return true;
      }
      if (slot.exclusive || (mode === "exclusive" && slot.shared.size)) return false;
      if (!turn(slot)) {
        if (mode !== "shared" || directAmount === undefined || directAmount !== quoteAmount || !fitsBesideWaiters(slot, directAmount)) return false;
        for (const peer of predecessors(slot)) this.spare.set(peer, this.spare.get(peer)! - directAmount);
      }
      if (mode === "exclusive") slot.exclusive = { owner, expires };
      else slot.shared.set(owner, expires);
      return true;
    };
    let waited = false;
    try {
      for (;;) {
        checkTime();
        const slot = this.slot(subjectId);
        // Proof writes may free the allowance needed by the head payment. Payments keep their FIFO order.
        if (!slot.exclusive && (turn(slot) || (quoteAmount !== undefined && !slot.proofWrites.length && predecessors(slot).every(peer => this.spare.has(peer))))) {
          try {
            const admitted = await ready(active, grant);
            checkTime();
            if (admitted === "recheck") {
              this.release(subjectId, owner);
              continue;
            }
            if (admitted && (this.mode(subjectId, owner) !== undefined || grant("exclusive"))) {
              this.assert(subjectId, owner);
              this.leave(subjectId, owner);
              return { waited };
            }
          } catch (error) {
            this.release(subjectId, owner);
            checkTime();
            if (error instanceof AllowanceWait) {
              const previous = this.spare.get(owner);
              if (previous === undefined || error.spare < previous) this.spare.set(owner, error.spare);
              if (previous === undefined) this.wake(this.slot(subjectId));
            } else this.spare.delete(owner);
            if (!(error instanceof WalletError) || error.code !== "PAYMENT_QUEUE_REQUIRED") throw error;
          }
          this.release(subjectId, owner);
        }
        const current = this.slot(subjectId);
        if (!proof && !current.line.includes(owner)) current.line.push(owner);
        wait.expires = expires;
        waited = true;
        const nap = new AbortController(), wake = () => nap.abort();
        const beganWaiting = this.now();
        current.wakers.add(wake);
        try { await this.delay(Math.min(2000, expires - this.now()), AbortSignal.any([active, nap.signal])); }
        catch (error) { if (active.aborted || !nap.signal.aborted) throw error; }
        finally { current.wakers.delete(wake); onWait?.(this.now() - beganWaiting); }
      }
    } catch (error) {
      this.release(subjectId, owner);
      this.leave(subjectId, owner);
      checkTime();
      throw error;
    } finally { this.spare.delete(owner); clearTimeout(timer); this.waiting.delete(owner); if (proof) this.proofWaiters--; }
  }
  assert(subjectId: string, owner: string): void {
    requireWallet(this.mode(subjectId, owner) !== undefined, "PAYMENT_ADMISSION_EXPIRED", "The original payment admission is unavailable.");
  }
  /** A host release also ends its in-progress acquisition, including an observation still awaiting IO. */
  cancel(subjectId: string, owner: string): void {
    this.waiting.get(owner)?.lifetime.abort(new WalletError("PAYMENT_ADMISSION_EXPIRED", "The original payment admission was released."));
    this.release(subjectId, owner);
  }
  release(subjectId: string, owner: string): void {
    const slot = this.slot(subjectId);
    const held = slot.exclusive?.owner === owner || slot.shared.has(owner);
    if (slot.exclusive?.owner === owner) delete slot.exclusive;
    slot.shared.delete(owner);
    if (held) this.wake(slot);
    if (!slot.exclusive && !slot.shared.size && !slot.line.length && !slot.proofWrites.length && !slot.wakers.size) this.slots.delete(subjectId);
  }
}
