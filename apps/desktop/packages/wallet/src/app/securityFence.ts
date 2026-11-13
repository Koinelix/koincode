import { requireWallet } from "../domain/errors.js";
import { abortable } from "./requestWait.js";

// This gate changes synchronously, before any protected-storage await.
export class SecurityFence {
  #generation = 0;
  #lastManagementChange = 0;
  #controls = 0;
  #closed = false;
  #payments = new Map<AbortController, Promise<void>>();
  #waitingPayments = 0;
  #proofWrite?: Promise<void>;
  #management = new AbortController();
  #stop = new AbortController();
  get signal(): AbortSignal {
    return this.#stop.signal;
  }
  beginControl(source: "management" | "leased_recovery" = "management"): () => void {
    requireWallet(
      !this.#closed && this.#controls < 32,
      "WALLET_BUSY",
      "The control queue is full.",
    );
    requireWallet(source !== "leased_recovery" || this.#payments.size === 0, "WALLET_BUSY", "A signer is still active.");
    this.#controls++;
    this.advance(source);
    let completed = false;
    return () => {
      if (!completed) this.#controls--;
      completed = true;
    };
  }
  capture(): number {
    requireWallet(
      !this.#closed && this.#controls === 0,
      "WALLET_BUSY",
      "Wallet control is changing.",
    );
    return this.#generation;
  }
  assertCurrent(generation: number): void {
    requireWallet(
      this.capture() === generation,
      "PAYMENT_CONTEXT_CHANGED",
      "The wallet security context changed before signing.",
    );
  }
  payment() {
    const generation = this.capture();
    requireWallet(!this.#proofWrite && this.#payments.size < 16, "WALLET_BUSY", "The signer is busy.");
    const controller = new AbortController();
    const done = Promise.withResolvers<void>();
    this.#payments.set(controller, done.promise);
    return { controller, generation, dispose: () => { this.#payments.delete(controller); done.resolve(); } };
  }
  /** All signing paths wait behind the brief committed proof write, including independent x402 clients. */
  async startPayment(signal?: AbortSignal) {
    requireWallet(this.#payments.size + this.#waitingPayments < 16, "WALLET_BUSY", "Too many payments are pending.");
    if (this.#proofWrite) {
      const active = AbortSignal.any([this.#stop.signal, this.#management.signal, ...(signal ? [signal] : [])]);
      this.#waitingPayments++;
      try { while (this.#proofWrite) await abortable(this.#proofWrite, active); }
      finally { this.#waitingPayments--; }
      active.throwIfAborted();
    }
    return this.payment();
  }
  /** The model admission owner serializes writers. Reserve their turn before waiting for existing signers. */
  async acquireProofWrite(signal: AbortSignal): Promise<() => void> {
    requireWallet(!this.#proofWrite, "WALLET_BUSY", "Another proof is being committed.");
    const active = AbortSignal.any([this.#stop.signal, signal]);
    active.throwIfAborted();
    const done = Promise.withResolvers<void>();
    this.#proofWrite = done.promise;
    const release = () => {
      if (this.#proofWrite === done.promise) this.#proofWrite = undefined;
      done.resolve();
    };
    try {
      if (this.#payments.size) await abortable(Promise.all(this.#payments.values()), active);
      active.throwIfAborted();
      return release;
    } catch (error) { release(); throw error; }
  }
  /** Only an unsigned admission may discard its observation after an exclusively leased proof write. */
  onlyRecoverySince(generation: number): boolean {
    return !this.#closed && this.#lastManagementChange <= generation && this.#generation > generation;
  }
  invalidate(): void {
    this.advance("management");
  }
  private advance(source: "management" | "leased_recovery"): void {
    this.#generation++;
    if (source === "management") {
      this.#lastManagementChange = this.#generation;
      this.#management.abort();
      this.#management = new AbortController();
    }
    for (const controller of this.#payments.keys()) controller.abort();
  }
  close(): void {
    this.#closed = true;
    this.#stop.abort();
    this.invalidate();
  }
}
