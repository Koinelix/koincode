import { initializeRepository } from "./initialization.js";
import {
  protectedJson,
  rootMatches,
  sameCommitment,
  type RootRegistration,
} from "./commitments.js";
import { types } from "node:util";
import type { ProtectedStore } from "./ports.js";
import type {
  InitializationTicket,
  StateCommitment,
  StateRepository,
  WalletState,
} from "./state.js";
import { WalletError, requireWallet } from "../domain/errors.js";

export class GuardedWalletState {
  private queue: Promise<unknown> = Promise.resolve();
  private selection = new AbortController();
  get walletSelectionSignal(): AbortSignal { return this.selection.signal; }
  private broken = false;
  private closed = false;
  private constructor(
    private readonly repository: StateRepository,
    private readonly protection: ProtectedStore,
    private state: WalletState,
  ) {}
  static async initialize(
    repository: StateRepository,
    protection: ProtectedStore,
    ticket: InitializationTicket,
  ): Promise<GuardedWalletState> {
    try {
      await initializeRepository(repository, protection, ticket);
    } catch (error) {
      repository.close();
      throw error;
    }
    return this.open(repository, protection);
  }
  static async open(
    repository: StateRepository,
    protection: ProtectedStore,
  ): Promise<GuardedWalletState> {
    try {
      const state = repository.read();
      const owner = new GuardedWalletState(repository, protection, state);
      const actual = repository.commitment(state);
      if (!repository.isReady()) {
        owner.broken = true;
        return owner;
      }
      const stored = repository.readCommitment();
      try {
        const root = await protectedJson<RootRegistration>(
          protection,
          "root:" + actual.storageBinding,
        );
        const external = await protectedJson<StateCommitment>(
          protection,
          "anchor:" + state.installationId,
        );
        owner.broken =
          !rootMatches(root, state, actual.storageBinding) ||
          root?.phase !== "READY" ||
          !sameCommitment(external, stored) ||
          !sameCommitment(stored, actual);
      } catch {
        owner.broken = true;
      }
      return owner;
    } catch (error) {
      repository.close();
      throw error;
    }
  }
  snapshot(): WalletState {
    requireWallet(!this.closed, "WALLET_CLOSED", "The wallet is closed.");
    return structuredClone(this.state);
  }
  continuityValid(): boolean {
    return !this.broken && !this.closed;
  }
  /** Trusted synchronous maintenance shares the original mutation queue and cannot overlap an anchor write. */
  inspectStable<T>(inspect: (state: WalletState, commitment: StateCommitment) => T): Promise<T> {
    const operation = this.queue.then(() => {
      requireWallet(!this.closed && !this.broken && !types.isAsyncFunction(inspect),
        "WALLET_RECOVERY_REQUIRED", "A stable original wallet snapshot is required.");
      const state = this.snapshot(), result = inspect(state, this.repository.commitment(state));
      if (result instanceof Promise) void result.catch(() => {});
      requireWallet(!(result instanceof Promise), "INVALID_TRANSACTION", "Stable inspection must complete synchronously.");
      return result;
    });
    this.queue = operation.catch(() => {}); return operation;
  }
  exportSnapshot(): { state: WalletState; commitment: StateCommitment } {
    const state = this.snapshot();
    return { state, commitment: this.repository.commitment(state) };
  }
  verifyBackupSnapshot(state: WalletState, commitment: StateCommitment): void {
    requireWallet(
      typeof commitment.storageBinding === "string" &&
        /^[0-9a-f]{64}$/.test(commitment.storageBinding) &&
        sameCommitment(this.repository.commitment(state, commitment.storageBinding), commitment),
      "BACKUP_INVALID",
      "The backup history commitment is invalid.",
    );
  }
  mutate<T>(change: (state: WalletState) => T): Promise<T> {
    const operation = this.queue.then(async () => {
      requireWallet(!this.closed, "WALLET_CLOSED", "The wallet is closed.");
      requireWallet(
        !this.broken,
        "WALLET_RECOVERY_REQUIRED",
        "Protected state continuity must be recovered.",
      );
      requireWallet(
        !types.isAsyncFunction(change),
        "INVALID_TRANSACTION",
        "A wallet state reducer must be synchronous.",
      );
      const next = structuredClone(this.state);
      const result = change(next);
      requireWallet(
        !(result instanceof Promise),
        "INVALID_TRANSACTION",
        "A wallet state reducer must be synchronous.",
      );
      next.revision = this.state.revision + 1;
      const accepted = structuredClone(next);
      const detachedResult = structuredClone(result);
      this.repository.validate(this.state, accepted);
      const commitment = this.repository.commitment(accepted);
      const bytes = Buffer.from(JSON.stringify(commitment));
      try {
        await this.protection.put("anchor:" + accepted.installationId, bytes);
        this.repository.commit(this.state, accepted, commitment);
        const selectionChanged = this.state.defaultWalletId !== accepted.defaultWalletId;
        this.state = accepted;
        if (selectionChanged) {
          const previous = this.selection;
          this.selection = new AbortController();
          previous.abort(new WalletError("PAYMENT_CONTEXT_CHANGED", "The selected payment wallet changed."));
        }
        this.broken = false;
      } catch {
        this.broken = true;
        throw new WalletError(
          "WALLET_STORAGE_FAILED",
          "The protected wallet state could not be committed. Recovery is required.",
        );
      } finally {
        bytes.fill(0);
      }
      return detachedResult;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.queue;
    this.repository.close();
  }
}
