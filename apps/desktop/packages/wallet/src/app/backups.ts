import { newTransport } from "./transportState.js";
import { mergeBackupTransport } from "./backupTransport.js";
import { validateBackupHistory, type BackupHistory } from "./backupHistory.js";
import { randomUUID } from "node:crypto";
import { budgetView } from "../domain/budget.js";
import { requireWallet } from "../domain/errors.js";
import type { BackupMetadata } from "./ports.js";
import {
  audit,
  disabledLimits,
  walletInfo,
  walletRecord,
  type RuntimeContext,
} from "./runtimeContext.js";
export class WalletBackups {
  constructor(private readonly ctx: RuntimeContext) {}
  async export(walletId: string, password: string, signal?: AbortSignal): Promise<string> {
    const ctx = this.ctx,
      snapshot = ctx.state.exportSnapshot(),
      wallet = walletRecord(snapshot.state, walletId);
    const history: BackupHistory = {
      version: snapshot.state.transport?.journalAnchors?.length ? 3 : snapshot.state.transport?.retentions?.length ? 2 : 1,
      walletId,
      continuityAtExport: ctx.state.continuityValid(),
      ...snapshot,
    };
    const metadata: BackupMetadata = {
      address: wallet.address,
      network: wallet.network,
      asset: wallet.asset,
      baselineBlock: wallet.baselineBlock,
      baselineHash: wallet.baselineHash,
      history: JSON.stringify(history),
    };
    return ctx.custody.exportBackup(
      wallet,
      metadata,
      password,
      AbortSignal.any([ctx.fence.signal, ...(signal ? [signal] : [])]),
    );
  }
  restore(
    backup: string,
    password: string,
    options: { acceptVerifiedGrossOutflow: boolean },
    signal?: AbortSignal,
  ) {
    const ctx = this.ctx;
    ctx.unlocks.lock();
    const accountingAccepted = options.acceptVerifiedGrossOutflow === true;
    const cancel = AbortSignal.any([ctx.fence.signal, ...(signal ? [signal] : [])]);
    return ctx.controls.run(async () => {
      ctx.unlocks.lock();
      requireWallet(
        ctx.state.continuityValid(),
        "WALLET_RECOVERY_REQUIRED",
        "A broken installation requires the explicit installation recovery entrypoint.",
      );
      const restored = await ctx.custody.restoreBackup(backup, password, cancel);
      const history = validateBackupHistory(restored.metadata, (state, commitment) =>
          ctx.state.verifyBackupSnapshot(state, commitment),
        ),
        sourceWallet = walletRecord(history.state, history.walletId);
      const sourceSubject = history.state.subjects.find(
        (subject) => subject.subjectId === sourceWallet.subjectId,
      )!;
      const sourceBudget = budgetView(
        sourceSubject,
        disabledLimits(),
        history.state.events,
        history.state.trustedTime,
      );
      const snapshot = await ctx.chain.snapshot(restored.key.network, restored.key.address, cancel);
      const now = ctx.clock.update(snapshot.latest.timestamp, ctx.state.snapshot().trustedTime);
      const wallet = await ctx.state.mutate((state) => {
        requireWallet(
          !cancel.aborted,
          "WALLET_OPERATION_ABORTED",
          "Backup restoration was canceled.",
        );
        let wallet = state.wallets.find(
          (wallet) => wallet.address.toLowerCase() === restored.key.address.toLowerCase(),
        );
        if (wallet) {
          requireWallet(wallet.kind !== "general_source" && restored.key.kind !== "general_source", "BACKUP_IDENTITY_CONFLICT",
            "Legacy restoration cannot replace a protected source binding.");
          requireWallet(
            wallet.network === restored.key.network &&
              wallet.asset === restored.metadata.asset.toLowerCase() &&
              wallet.baselineBlock === restored.metadata.baselineBlock &&
              wallet.baselineHash === restored.metadata.baselineHash,
            "BACKUP_IDENTITY_CONFLICT",
            "A restored address cannot replace its original budget identity or baseline.",
          );
          // Healthy current history always wins over an older exported history.
          wallet.keyRef = restored.key.keyRef;
          wallet.keystore = restored.key.keystore;
        } else {
          const sameOwner = history.state.ownerId === state.ownerId;
          const subjectId = sameOwner ? sourceWallet.subjectId : randomUUID();
          requireWallet(
            !state.subjects.some((subject) => subject.subjectId === subjectId),
            "BACKUP_IDENTITY_CONFLICT",
            "The restored budget subject conflicts with an existing identity.",
          );
          wallet = {
            ...restored.key,
            walletId: sameOwner ? sourceWallet.walletId : randomUUID(),
            subjectId,
            asset: restored.metadata.asset.toLowerCase(),
            baselineBlock: restored.metadata.baselineBlock,
            baselineHash: restored.metadata.baselineHash,
          };
          state.wallets.push(wallet);
          state.subjects.push({
            subjectId,
            ownerId: state.ownerId,
            address: wallet.address.toLowerCase(),
            network: wallet.network,
            asset: wallet.asset,
            recoveryRequired: true,
            signingPaused: false,
          });
          state.policies[subjectId] = disabledLimits();
          const riskExpiresAfter = Math.max(
            now + 120,
            ...history.state.intents
              .filter((intent) => intent.subjectId === sourceWallet.subjectId)
              .map((intent) => intent.validBefore),
          );
          state.recoveries.push({
            recoveryId: randomUUID(),
            subjectId,
            sourceInstallationId: history.state.installationId,
            sourceOwnerId: history.state.ownerId,
            sourceHistory: restored.metadata.history,
            baselineBlock: wallet.baselineBlock,
            baselineHash: wallet.baselineHash,
            startedAt: now,
            riskExpiresAfter,
            targetBlock: null,
            targetHash: null,
            targetTime: null,
            nextBlock: wallet.baselineBlock,
            lastVerifiedBlock: wallet.baselineBlock,
            lastVerifiedHash: wallet.baselineHash,
            verifiedOutflowAtomic: "0",
            sourceCumulativeAtomic: sourceBudget.cumulativeSpentAtomic,
            accountingAccepted,
            status: accountingAccepted ? "waiting_safe" : "blocked",
            errorCode: accountingAccepted ? null : "RECOVERY_ACCOUNTING_APPROVAL_REQUIRED",
          });
        }
        state.managementEpoch = randomUUID();
        if (history.state.transport) {
          state.transport ??= newTransport(state.managementEpoch);
          if (history.state.ownerId === state.ownerId)
            mergeBackupTransport(state.transport, history.state.transport);
        }

        if (state.transport) {
          state.transport.epoch = state.managementEpoch;
          state.transport.historyComplete = false;
          for (const record of state.transport.retentions ?? [])
            if (record.state !== "deleted") record.state = "deleting";
        }
        state.sessions = [];
        for (const client of state.clients) {
          client.active = false;
          client.generation++;
        }
        for (const grant of state.grants)
          if (grant.status === "active") {
            grant.status = "paused";
            grant.version++;
          }
        for (const permit of state.permits) permit.status = "invalidated";
        for (const policy of Object.values(state.policies)) {
          policy.enabled = false;
          policy.version++;
        }
        state.defaultWalletId ??= wallet.walletId;
        state.trustedTime = Math.max(state.trustedTime, now);
        audit(state, "BACKUP_RESTORED", wallet.subjectId, {
          sourceInstallationId: history.state.installationId,
        });
        return wallet;
      });
      for (const client of ctx.state.snapshot().clients)
        ctx.sessions.invalidateClient(client.clientId);
      return {
        wallet: walletInfo(ctx, wallet),
        recoveryId:
          ctx.state
            .snapshot()
            .recoveries.find(
              (recovery) =>
                recovery.subjectId === wallet.subjectId && recovery.status !== "complete",
            )?.recoveryId ?? null,
      };
    });
  }
}
