import { registerLocalPaymentSource } from "./localPaymentRegistration.js";
import { createHash } from "node:crypto";
import { listLocalLegacyAccounts, revealLocalLegacyKey } from "./localWalletManagement.js";
import { WalletRequests } from "./requests.js";
import type { RequestEnvironment } from "./requestPorts.js";
import type { PaymentBuilder } from "./paymentBuilder.js";
import type { ProtectedStore } from "./ports.js";
import { inspectWallet, walletBudgetQuery } from "./managementView.js";
import { requireWallet } from "../domain/errors.js";
import type { ClockSources } from "./clock.js";
import { TrustedWalletClock } from "./clock.js";
import type { GuardedWalletState } from "./guardedState.js";
import type { KeyCustody, WalletChain } from "./ports.js";
import { WalletManagement } from "./management.js";
import { WalletPayments } from "./payments.js";
import { WalletReconciliation } from "./reconciliation.js";
import { SecurityFence } from "./securityFence.js";
import { WalletControls } from "./controls.js";
import { WalletBackups } from "./backups.js";
import { WalletRecovery } from "./recovery.js";
import { WalletSessions, type ClientHandle } from "./sessions.js";
import { WalletUnlocks } from "./unlock.js";
import { audit, walletInfo, walletRecord, type RuntimeContext } from "./runtimeContext.js";
import type {
  WalletDisplayInfo,
  WalletInfo,
  WalletQuery,
  WalletInspectionSection,
} from "./runtimeTypes.js";

export class WalletRuntime {
  get paymentNetwork() { return this.#ctx.paymentNetwork; }
  readonly management: WalletManagement;
  readonly payments: WalletPayments;
  readonly sessions: WalletSessions;
  readonly reconciliation: WalletReconciliation;
  readonly backups: WalletBackups;
  readonly recovery: WalletRecovery;
  #ctx: RuntimeContext;
  #closing: Promise<void> | null = null;
  #requests: WalletRequests | null = null;
  #enabling = false;
  #requestStartup: Promise<WalletRequests> | null = null;
  /** Trusted runtime owner only; system storage and payment authorization remain mandatory. */
  useSystemProtection(): void {
    requireWallet(!this.#closing, "WALLET_OPERATION_ABORTED", "The wallet is closing.");
    this.#ctx.unlocks.useSystemProtection();
  }
  private constructor(
    state: GuardedWalletState,
    custody: KeyCustody,
    chain: WalletChain,
    sources: ClockSources,
    generalSources?: RuntimeContext["generalSources"],
    paymentNetwork: import("../domain/model.js").Network = "eip155:84532",
  ) {
    this.sessions = new WalletSessions(state);
    const fence = new SecurityFence(),
      unlocks = new WalletUnlocks(sources.monotonic);
    this.#ctx = {
      state,
      paymentNetwork,
      generalSources,
      custody,
      chain,
      sessions: this.sessions,
      clock: new TrustedWalletClock(sources),
      unlocks,
      fence,
      controls: new WalletControls(fence, unlocks),
    };
    this.management = new WalletManagement(this.#ctx);
    this.payments = new WalletPayments(this.#ctx);
    this.reconciliation = new WalletReconciliation(this.#ctx);
    this.backups = new WalletBackups(this.#ctx);
    this.recovery = new WalletRecovery(this.#ctx);
  }
  static async start(
    state: GuardedWalletState,
    custody: KeyCustody,
    chain: WalletChain,
    sources: ClockSources,
    generalSources?: RuntimeContext["generalSources"],
    paymentNetwork: import("../domain/model.js").Network = "eip155:84532",
  ): Promise<WalletRuntime> {
    const runtime = new WalletRuntime(state, custody, chain, sources, generalSources, paymentNetwork);
    if (state.continuityValid())
      await state.mutate((next) => {
        next.sessions = [];
        for (const grant of next.grants)
          if (grant.scope !== "persistent" && grant.status === "active") {
            grant.status = "paused";
            grant.version++;
          }
        for (const permit of next.permits) permit.status = "invalidated";
        for (const intent of next.intents)
          if (intent.status === "SIGNING") intent.status = "UNKNOWN";
        audit(next, "WALLET_RUNTIME_STARTED", null);
      });
    return runtime;
  }
  async enableRequests(
    environment: RequestEnvironment,
    protection: ProtectedStore,
    builder: PaymentBuilder,
  ): Promise<WalletRequests> {
    requireWallet(
      typeof environment.inspectResponse === "function",
      "INVALID_REQUEST_CONFIGURATION",
      "A trusted response inspection adapter is required.",
    );
    requireWallet(
      !this.#requests && !this.#enabling && !this.#closing,
      "STATE_CONFLICT",
      "The request service already exists or the wallet is closing.",
    );
    this.#enabling = true;
    try {
      this.#requestStartup = WalletRequests.start(
        this.#ctx,
        this.reconciliation,
        environment,
        protection,
        this.payments,
        builder,
      );
      const requests = await this.#requestStartup;
      requireWallet(
        !this.#closing,
        "WALLET_CLOSED",
        "The wallet closed during request initialization.",
      );
      this.#requests = requests;
      return this.#requests;
    } finally {
      this.#enabling = false;
      this.#requestStartup = null;
    }
  }
  /** Private local management duplicate check; never accepts a renderer projection. */
  lookupManagedAddress(address: string): "match" | "none" | "unavailable" {
    if (!this.#ctx.state.continuityValid()) return "unavailable";
    return this.#ctx.state.snapshot().wallets.some((wallet) => wallet.address.toLowerCase() === address.toLowerCase()) ? "match" : "none";
  }
  registerLocalPaymentSource(key: Parameters<typeof registerLocalPaymentSource>[1], signal: AbortSignal) {
    return registerLocalPaymentSource(this.#ctx, key, signal);
  }
  async upgradeLocalPaymentSources(authorize: (digest: string, signal: AbortSignal) => Promise<boolean>, signal: AbortSignal) {
    const ctx = this.#ctx;
    return ctx.controls.run(async () => {
      requireWallet(ctx.state.continuityValid() && ctx.generalSources && !signal.aborted, "WALLET_RECOVERY_REQUIRED", "The original wallet owner is required.");
      if (ctx.generalSources.ready()) return { upgraded: false, backupPath: null };
      await this.payments.drain();
      const before = await ctx.state.inspectStable((_state, commitment) => commitment);
      const digest = createHash("sha256").update(JSON.stringify(["local-source-upgrade-v1", before])).digest("hex");
      requireWallet(await authorize(digest, signal), "GENERAL_AUTH_REQUIRED", "The explicit source upgrade requires system authentication.");
      return ctx.state.inspectStable((_state, commitment) => {
        requireWallet(!signal.aborted && !ctx.fence.signal.aborted && JSON.stringify(commitment) === JSON.stringify(before),
          "GENERAL_OPERATION_CANCELED", "The original ledger changed during upgrade authentication.");
        return { upgraded: true, ...ctx.generalSources!.upgrade() };
      });
    });
  }
  listLocalManagementAccounts() { return listLocalLegacyAccounts(this.#ctx); }
  revealLocalManagementKey(walletId: string, authorize: Parameters<typeof revealLocalLegacyKey>[2], signal: AbortSignal) {
    return revealLocalLegacyKey(this.#ctx, walletId, authorize, signal);
  }
  list(): WalletInfo[] {
    return this.#ctx.state.snapshot().wallets.map((wallet) => walletInfo(this.#ctx, wallet));
  }
  /** Trusted host only. It must subtract request transit time before scheduling invalidation. */
  listForDisplay(): WalletDisplayInfo[] {
    return this.#ctx.state.snapshot().wallets.map((wallet) => {
      const state = this.#ctx.unlocks.displayState(wallet.walletId);
      return {
        ...walletInfo(this.#ctx, wallet, state.locked),
        unlockRemainingMs: state.unlockRemainingMs,
      };
    });
  }
  query(handle: ClientHandle, walletId: string): WalletQuery {
    const ctx = this.#ctx,
      state = ctx.state.snapshot(),
      wallet = walletRecord(state, walletId);
    this.sessions.requireSubject(handle, wallet.subjectId, state);
    return walletBudgetQuery(ctx, state, wallet);
  }
  inspectWallet(walletId: string, section: WalletInspectionSection, offset = 0) {
    return inspectWallet(this.#ctx, walletId, section, offset);
  }
  async refresh(handle: ClientHandle, walletId: string, signal?: AbortSignal) {
    const ctx = this.#ctx,
      state = ctx.state.snapshot(),
      wallet = walletRecord(state, walletId);
    this.sessions.requireSubject(handle, wallet.subjectId, state);
    const cancel = AbortSignal.any([ctx.fence.signal, ...(signal ? [signal] : [])]);
    const snapshot = await ctx.chain.snapshot(wallet.network, wallet.address, cancel);
    this.sessions.requireSubject(handle, wallet.subjectId, ctx.state.snapshot());
    const now = ctx.clock.update(snapshot.latest.timestamp, ctx.state.snapshot().trustedTime);
    if (ctx.state.continuityValid())
      await ctx.state.mutate((next) => {
        requireWallet(
          !cancel.aborted,
          "WALLET_OPERATION_ABORTED",
          "The balance refresh was canceled.",
        );
        next.trustedTime = Math.max(next.trustedTime, now);
      });
    return snapshot;
  }
  cancelHostInteraction(): void {
    this.#ctx.unlocks.cancelHostInteraction();
    this.#ctx.fence.invalidate();
  }
  lockForHostEvent(): void {
    this.#ctx.unlocks.lock();
    this.#ctx.fence.invalidate();
  }
  close(): Promise<void> {
    if (!this.#closing) {
      this.#ctx.fence.close();
      this.#ctx.unlocks.lock();
      this.sessions.close();
      this.#closing = Promise.allSettled([
        this.#requests?.close(),
        this.#requestStartup?.then((requests) => requests.close()),
        this.management.drain(),
        this.payments.drain(),
      ]).then(() => this.#ctx.state.close());
    }
    return this.#closing;
  }
}
