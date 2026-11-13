import { randomUUID } from "node:crypto";
import { ensureDesktopClient, synchronizeDesktopClientScope } from "./desktopClient.js";
import { createGrantInState } from "./grantCreation.js";
import { atomic } from "../domain/atomic.js";
import { requireWallet, WalletError } from "../domain/errors.js";
import { networkConfig } from "../domain/networks.js";
import type { ManagedKey } from "./ports.js";
import type { GrantInput, ManagementCommand, ManagementResult } from "./runtimeTypes.js";
import {
  audit,
  disabledLimits,
  walletInfo,
  walletRecord,
  type RuntimeContext,
} from "./runtimeContext.js";

export class WalletManagement {
  constructor(private readonly ctx: RuntimeContext) {}
  execute(command: ManagementCommand, signal?: AbortSignal): Promise<ManagementResult> {
    if (
      (command.action === "lock" || command.action === "unlock") &&
      !this.ctx.unlocks.requiresExplicitUnlock
    )
      return Promise.reject(
        new WalletError(
          "EXPLICIT_LOCK_UNAVAILABLE",
          "This wallet uses system-protected storage without an explicit lock.",
        ),
      );
    const unlockGeneration = this.ctx.unlocks.lockGeneration;
    signal = AbortSignal.any([this.ctx.fence.signal, ...(signal ? [signal] : [])]);
    // Preserve only the process-owned connection capability; freeze all JSON input now.
    const connection = command.action === "grant" ? command.grant.connection : undefined;
    const frozen =
      command.action === "grant"
        ? {
            ...structuredClone({ ...command, grant: { ...command.grant, connection: undefined } }),
            grant: { ...structuredClone({ ...command.grant, connection: undefined }), connection },
          }
        : structuredClone(command);
    if (frozen.action === "lock") this.ctx.unlocks.lock(frozen.walletId);
    if (frozen.action === "revoke_client") this.ctx.sessions.invalidateClient(frozen.clientId);
    return this.ctx.controls.run(async () => {
      requireWallet(
        !signal?.aborted,
        "WALLET_OPERATION_ABORTED",
        "The control operation was canceled.",
      );
      requireWallet(
        this.ctx.state.continuityValid(),
        "WALLET_RECOVERY_REQUIRED",
        "Protected state continuity is unavailable.",
      );
      return this.apply(frozen, signal, unlockGeneration);
    });
  }
  async drain(): Promise<void> {
    await this.ctx.controls.drain();
  }
  private async enroll(
    key: ManagedKey,
    signal?: AbortSignal,
    legacy = false,
  ): Promise<ManagementResult> {
    requireWallet(key.network === this.ctx.paymentNetwork, "PAYMENT_NETWORK_MISMATCH", "The source differs from the fixed wallet network.");
    const current = this.ctx.state.snapshot();
    const existing = current.wallets.find(
      (wallet) => wallet.address.toLowerCase() === key.address.toLowerCase(),
    );
    if (existing) {
      requireWallet(
        existing.network === key.network,
        "NETWORK_KEY_REUSE",
        "Testnet and mainnet require separate keys.",
      );
      return { wallet: walletInfo(this.ctx, existing) };
    }
    requireWallet(
      !legacy || current.recoveries.length === 0,
      "TEST_WALLET_IMPORT_DISABLED",
      "After installation recovery, unknown keys require an authenticated baseline backup rather than fresh legacy adoption.",
    );
    const snapshot = await this.ctx.chain.snapshot(key.network, key.address, signal);
    const now = this.ctx.clock.update(snapshot.latest.timestamp, current.trustedTime);
    const wallet = await this.ctx.state.mutate((state) => {
      requireWallet(
        !signal?.aborted,
        "WALLET_OPERATION_ABORTED",
        "Wallet enrollment was canceled.",
      );
      requireWallet(
        !state.wallets.some((wallet) => wallet.address.toLowerCase() === key.address.toLowerCase()),
        "STATE_CONFLICT",
        "The wallet address is already managed.",
      );
      const walletId = randomUUID(),
        subjectId = randomUUID();
      const wallet = {
        ...key,
        walletId,
        subjectId,
        asset: networkConfig(key.network).asset,
        baselineBlock: snapshot.latest.number,
        baselineHash: snapshot.latest.hash,
      };
      state.wallets.push(wallet);
      state.subjects.push({
        subjectId,
        ownerId: state.ownerId,
        address: key.address.toLowerCase(),
        network: key.network,
        asset: wallet.asset,
        recoveryRequired: false,
        signingPaused: false,
      });
      state.policies[subjectId] = disabledLimits();
      state.defaultWalletId ??= walletId;
      synchronizeDesktopClientScope(state);
      state.trustedTime = Math.max(state.trustedTime, now);
      audit(state, "WALLET_ENROLLED", subjectId, { baselineBlock: wallet.baselineBlock });
      return wallet;
    });
    return { wallet: walletInfo(this.ctx, wallet) };
  }
  private async createGrant(input: GrantInput, signal?: AbortSignal): Promise<ManagementResult> {
    const grantId = await this.ctx.state.mutate((state) => {
      requireWallet(
        !signal?.aborted,
        "WALLET_OPERATION_ABORTED",
        "The grant operation was canceled.",
      );
      return createGrantInState(this.ctx, state, input, this.ctx.clock.now());
    });
    return { grantId };
  }
  private async apply(
    command: ManagementCommand,
    signal?: AbortSignal,
    unlockGeneration?: number,
  ): Promise<ManagementResult> {
    const ctx = this.ctx;
    if (command.action === "create") {
      requireWallet(command.network === ctx.paymentNetwork, "PAYMENT_NETWORK_MISMATCH", "The requested network differs from the fixed wallet network.");
      return this.enroll(await ctx.custody.create(command.network, signal), signal);
    }
    if (command.action === "import_test")
      return this.enroll(await ctx.custody.importTestWallet(command.path, signal), signal, true);
    if (command.action === "grant") return this.createGrant(command.grant, signal);
    if (command.action === "unlock") {
      requireWallet(
        unlockGeneration === ctx.unlocks.lockGeneration,
        "WALLET_LOCKED",
        "The unlock request predates a lock or security event. Fresh trusted authentication is required.",
      );
      const wallet = walletRecord(ctx.state.snapshot(), command.walletId);
      requireWallet(
        command.scope === undefined || command.scope === "application",
        "INVALID_UNLOCK_DURATION",
        "The unlock scope is invalid.",
      );
      if (command.scope === "application") {
        requireWallet(
          command.durationMs === undefined && command.idleMs === undefined,
          "INVALID_UNLOCK_DURATION",
          "Application sessions cannot include time limits.",
        );
        ctx.unlocks.unlockForApplication(wallet.walletId);
      } else ctx.unlocks.unlock(wallet.walletId, command.durationMs, command.idleMs);
      return { wallet: walletInfo(ctx, wallet) };
    }
    return ctx.state.mutate((state) => {
      if (command.action === "ensure_desktop_client") return ensureDesktopClient(state);
      if (command.action === "lock") {
        ctx.unlocks.lock(command.walletId);
        audit(state, "WALLET_LOCKED", null);
        return {};
      }
      if (command.action === "default") {
        const wallet = walletRecord(state, command.walletId);
        state.defaultWalletId = wallet.walletId;
        synchronizeDesktopClientScope(state);
        audit(state, "DEFAULT_CHANGED", wallet.subjectId);
      } else if (command.action === "resume_signing") {
        const wallet = walletRecord(state, command.walletId),
          subject = state.subjects.find((subject) => subject.subjectId === wallet.subjectId)!;
        requireWallet(
          !subject.recoveryRequired,
          "WALLET_RECOVERY_REQUIRED",
          "Unknown history cannot be acknowledged as safe.",
        );
        subject.signingPaused = false;
        audit(state, "SIGNING_PAUSE_ACKNOWLEDGED", wallet.subjectId);
      } else if (command.action === "limits") {
        const wallet = walletRecord(state, command.walletId),
          limits = command.limits;
        atomic(limits.maxPerPaymentAtomic);
        atomic(limits.maxRolling24hAtomic);
        atomic(limits.maxCumulativeAtomic);
        requireWallet(
          typeof limits.enabled === "boolean",
          "INVALID_LIMITS",
          "Limits must be explicitly enabled or disabled.",
        );
        state.policies[wallet.subjectId] = {
          ...limits,
          version: state.policies[wallet.subjectId]!.version + 1,
        };
        audit(state, "LIMITS_CHANGED", wallet.subjectId);
      } else if (command.action === "register_client") {
        requireWallet(
          ["internal", "external"].includes(command.kind) &&
            command.subjectIds.length > 0 &&
            command.subjectIds.length <= 128 &&
            new Set(command.subjectIds).size === command.subjectIds.length &&
            command.subjectIds.every((id) =>
              state.subjects.some((subject) => subject.subjectId === id),
            ),
          "CLIENT_CONTEXT_INVALID",
          "Client scope must contain managed subjects.",
        );
        const clientId = randomUUID();
        state.clients.push({
          registrationEpoch: state.managementEpoch,
          clientId,
          ownerId: state.ownerId,
          generation: 1,
          active: true,
          kind: command.kind,
          subjectIds: [...command.subjectIds],
        });
        audit(state, "CLIENT_REGISTERED", null, { clientId });
        return { clientId };
      } else if (command.action === "revoke_client") {
        const client = state.clients.find((client) => client.clientId === command.clientId);
        requireWallet(client, "CLIENT_NOT_FOUND", "The client does not exist.");
        if (state.transport) {
          const token = state.transport.tokens.find(
            (record) => record.clientId === client.clientId,
          );
          if (token) token.active = false;
          for (const credential of state.transport.credentials)
            if (credential.clientIds.includes(client.clientId)) {
              credential.clientIds = credential.clientIds.filter((id) => id !== client.clientId);
              credential.version++;
            }
        }
        client.active = false;
        client.generation++;
        state.sessions = state.sessions.filter((session) => session.clientId !== client.clientId);
        audit(state, "CLIENT_REVOKED", null, { clientId: client.clientId });
      } else if (command.action === "revoke_grant") {
        const grant = state.grants.find((grant) => grant.grantId === command.grantId);
        requireWallet(grant, "GRANT_INVALID", "The grant does not exist.");
        grant.status = "revoked";
        grant.version++;
        audit(state, "GRANT_REVOKED", grant.subjectId, { grantId: grant.grantId });
      }
      return {};
    });
  }
}
