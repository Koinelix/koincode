import { randomUUID } from "node:crypto";
import { atomic } from "../domain/atomic.js";
import { requireWallet, WalletError } from "../domain/errors.js";
import { audit, type RuntimeContext } from "./runtimeContext.js";
import type { RecoveryRecord } from "./state.js";
const view = (record: RecoveryRecord) => ({
  recoveryId: record.recoveryId,
  subjectId: record.subjectId,
  status: record.status,
  baselineBlock: record.baselineBlock,
  nextBlock: record.nextBlock,
  targetBlock: record.targetBlock,
  verifiedOutflowAtomic: record.verifiedOutflowAtomic,
  verifiedReceiptsInPage: record.pendingPage?.nextIndex ?? 0,
  errorCode: record.errorCode,
});
export class WalletRecovery {
  constructor(private readonly ctx: RuntimeContext) {}
  list() {
    return this.ctx.state.snapshot().recoveries.map(view);
  }
  status(recoveryId: string) {
    const record = this.ctx.state
      .snapshot()
      .recoveries.find((record) => record.recoveryId === recoveryId);
    requireWallet(record, "RECOVERY_NOT_FOUND", "The recovery session does not exist.");
    return view(record);
  }
  acceptVerifiedGrossOutflow(recoveryId: string) {
    return this.ctx.controls.run(async () =>
      this.ctx.state.mutate((state) => {
        const record = state.recoveries.find((record) => record.recoveryId === recoveryId);
        requireWallet(
          record && record.status !== "complete",
          "RECOVERY_NOT_FOUND",
          "The active recovery session does not exist.",
        );
        record.accountingAccepted = true;
        record.status = "waiting_safe";
        record.errorCode = null;
        audit(state, "RECOVERY_GROSS_OUTFLOW_ACCEPTED", record.subjectId, { recoveryId });
        return view(record);
      }),
    );
  }
  scan(
    recoveryId: string,
    options: { maxPages?: number; pageBlocks?: number } = {},
    signal?: AbortSignal,
  ) {
    const maxPages = options.maxPages ?? 4,
      pageBlocks = options.pageBlocks ?? 200;
    requireWallet(
      Number.isSafeInteger(maxPages) &&
        maxPages > 0 &&
        maxPages <= 8 &&
        Number.isSafeInteger(pageBlocks) &&
        pageBlocks > 0 &&
        pageBlocks <= 200,
      "RECOVERY_RANGE_INVALID",
      "Recovery work must have finite page and block limits.",
    );
    const ctx = this.ctx,
      cancel = AbortSignal.any([
        ctx.fence.signal,
        AbortSignal.timeout(30000),
        ...(signal ? [signal] : []),
      ]);
    return ctx.controls.run(async () => {
      try {
        requireWallet(
          ctx.chain.historyPage,
          "RPC_UNAVAILABLE",
          "Complete RPC history verification is unavailable.",
        );
        let state = ctx.state.snapshot(),
          record = state.recoveries.find((record) => record.recoveryId === recoveryId);
        requireWallet(record, "RECOVERY_NOT_FOUND", "The recovery session does not exist.");
        if (record.status === "complete") return view(record);
        requireWallet(
          record.accountingAccepted,
          "RECOVERY_ACCOUNTING_APPROVAL_REQUIRED",
          "Conservative verified gross-outflow accounting requires trusted confirmation.",
        );
        const wallet = state.wallets.find((wallet) => wallet.subjectId === record!.subjectId)!;
        const sample = await ctx.chain.snapshot(wallet.network, wallet.address, cancel);
        const now = ctx.clock.update(sample.latest.timestamp, state.trustedTime);
        if (record.targetBlock === null) {
          if (
            sample.safe.timestamp <= record.riskExpiresAfter ||
            sample.safe.number < record.baselineBlock
          )
            return view(record);
          await ctx.state.mutate((state) => {
            requireWallet(!cancel.aborted, "WALLET_OPERATION_ABORTED", "Recovery was canceled.");
            const record = state.recoveries.find((record) => record.recoveryId === recoveryId)!;
            record.targetBlock = sample.safe.number;
            record.targetHash = sample.safe.hash;
            record.targetTime = sample.safe.timestamp;
            record.status = "scanning";
            record.errorCode = null;
            state.trustedTime = Math.max(state.trustedTime, now);
            audit(state, "RECOVERY_SAFE_TARGET", record.subjectId, {
              recoveryId,
              targetBlock: sample.safe.number,
            });
          });
        }
        for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
          state = ctx.state.snapshot();
          record = state.recoveries.find((record) => record.recoveryId === recoveryId)!;
          requireWallet(
            record.targetBlock !== null &&
              record.targetHash !== null &&
              record.targetTime !== null &&
              record.targetTime > record.riskExpiresAfter,
            "RECOVERY_RANGE_INVALID",
            "A safe target beyond all possible authorization lifetimes is required.",
          );
          const fromBlock = record.nextBlock,
            toBlock =
              record.pendingPage?.toBlock ??
              Math.min(record.targetBlock, fromBlock + pageBlocks - 1);
          requireWallet(
            fromBlock <= toBlock,
            "RECOVERY_RANGE_INVALID",
            "The next recovery range is invalid.",
          );
          const page = await ctx.chain.historyPage(
            {
              network: wallet.network,
              payer: wallet.address,
              asset: wallet.asset,
              baselineBlock: record.baselineBlock,
              baselineHash: record.baselineHash,
              checkpointBlock: record.lastVerifiedBlock,
              checkpointHash: record.lastVerifiedHash,
              targetBlock: record.targetBlock,
              targetHash: record.targetHash,
              fromBlock,
              toBlock,
              cursor: record.pendingPage
                ? {
                    logsDigest: record.pendingPage.logsDigest,
                    nextIndex: record.pendingPage.nextIndex,
                    outflows: record.pendingPage.outflows,
                  }
                : undefined,
            },
            cancel,
          );
          await ctx.state.mutate((state) => {
            requireWallet(
              !cancel.aborted,
              "WALLET_OPERATION_ABORTED",
              "Recovery was canceled before committing its checkpoint.",
            );
            const record = state.recoveries.find((record) => record.recoveryId === recoveryId)!;
            requireWallet(
              record.nextBlock === fromBlock &&
                page.fromBlock === fromBlock &&
                page.toBlock === toBlock &&
                /^0x[0-9a-f]{64}$/.test(page.endHash),
              "RECOVERY_RANGE_INVALID",
              "The verified page does not extend the current checkpoint.",
            );
            requireWallet(
              /^[0-9a-f]{64}$/.test(page.logsDigest) &&
                Number.isSafeInteger(page.nextIndex) &&
                page.nextIndex === page.outflows.length &&
                page.outflows.length <= 512 &&
                (page.complete || page.nextIndex > (record.pendingPage?.nextIndex ?? 0)) &&
                (!record.pendingPage ||
                  (record.pendingPage.fromBlock === fromBlock &&
                    record.pendingPage.toBlock === toBlock &&
                    record.pendingPage.logsDigest === page.logsDigest &&
                    record.pendingPage.outflows.every((flow, index) => {
                      const next = page.outflows[index];
                      return (
                        next &&
                        flow.evidenceKey === next.evidenceKey &&
                        flow.amountAtomic === next.amountAtomic &&
                        flow.settledAt === next.settledAt &&
                        flow.txHash === next.txHash &&
                        flow.logIndex === next.logIndex &&
                        flow.block.number === next.block.number &&
                        flow.block.hash === next.block.hash &&
                        flow.block.timestamp === next.block.timestamp
                      );
                    }))),
              "RECOVERY_PAGE_CHANGED",
              "The verified receipt cursor must extend its protected prefix.",
            );
            for (const flow of page.outflows) {
              requireWallet(
                flow.block.number >= fromBlock &&
                  flow.block.number <= toBlock &&
                  flow.settledAt === flow.block.timestamp &&
                  flow.settledAt <= record.targetTime! &&
                  flow.settledAt <= now,
                "RPC_EVIDENCE_INVALID",
                "A partial receipt lies outside its frozen safe target.",
              );
              atomic(flow.amountAtomic);
            }
            if (!page.complete) {
              record.pendingPage = {
                fromBlock,
                toBlock,
                logsDigest: page.logsDigest,
                nextIndex: page.nextIndex,
                outflows: page.outflows,
              };
              record.errorCode = null;
              state.trustedTime = Math.max(state.trustedTime, now);
              audit(state, "RECOVERY_RECEIPT_PREFIX_VERIFIED", record.subjectId, {
                recoveryId,
                fromBlock,
                toBlock,
                nextIndex: page.nextIndex,
              });
              return;
            }
            const unique = new Set<string>();
            let total = atomic(record.verifiedOutflowAtomic);
            for (const flow of page.outflows) {
              requireWallet(
                !unique.has(flow.evidenceKey) &&
                  flow.block.number >= fromBlock &&
                  flow.block.number <= toBlock &&
                  flow.settledAt === flow.block.timestamp &&
                  flow.settledAt <= record.targetTime! &&
                  flow.settledAt <= now,
                "RPC_EVIDENCE_INVALID",
                "An outflow conflicts with its recovery page.",
              );
              unique.add(flow.evidenceKey);
              const amount = atomic(flow.amountAtomic);
              const existing = state.events.find(
                (event) =>
                  event.subjectId === record.subjectId && event.evidenceKey === flow.evidenceKey,
              );
              if (existing) {
                requireWallet(
                  existing.spentDelta === flow.amountAtomic &&
                    existing.settledAt === flow.settledAt,
                  "EVIDENCE_CONFLICT",
                  "Recovery evidence conflicts with an existing spending event.",
                );
                continue;
              }
              if (amount > 0n)
                state.events.push({
                  eventId: randomUUID(),
                  subjectId: record.subjectId,
                  intentId: null,
                  kind: "RECOVERY_BASELINE",
                  reservedDelta: "0",
                  spentDelta: flow.amountAtomic,
                  settledAt: flow.settledAt,
                  recordedAt: now,
                  evidenceKey: flow.evidenceKey,
                });
              total += amount;
            }
            record.verifiedOutflowAtomic = total.toString();
            delete record.pendingPage;
            record.lastVerifiedBlock = toBlock;
            record.lastVerifiedHash = page.endHash;
            record.nextBlock = toBlock + 1;
            record.errorCode = null;
            state.trustedTime = Math.max(state.trustedTime, now);
            if (toBlock === record.targetBlock) {
              requireWallet(
                total >= atomic(record.sourceCumulativeAtomic),
                "RECOVERY_HISTORY_CONFLICT",
                "Complete canonical outflow is lower than authenticated historical spending.",
              );
              requireWallet(
                page.endHash === record.targetHash,
                "RECOVERY_ANCHOR_CHANGED",
                "The completed recovery target changed.",
              );
              record.status = "complete";
              state.subjects.find(
                (subject) => subject.subjectId === record.subjectId,
              )!.recoveryRequired = false;
            } else record.status = "scanning";
            audit(state, "RECOVERY_PAGE_VERIFIED", record.subjectId, {
              recoveryId,
              fromBlock,
              toBlock,
              complete: record.status === "complete",
            });
          });
          const current = ctx.state
            .snapshot()
            .recoveries.find((record) => record.recoveryId === recoveryId)!;
          if (current.status === "complete") return view(current);
        }
        return this.status(recoveryId);
      } catch (error) {
        const code = error instanceof WalletError ? error.code : "RPC_UNAVAILABLE";
        if (ctx.state.continuityValid())
          await ctx.state
            .mutate((state) => {
              const record = state.recoveries.find((record) => record.recoveryId === recoveryId);
              if (record && record.status !== "complete") record.errorCode = code;
            })
            .catch(() => {});
        throw new WalletError(
          code,
          "Recovery remains blocked; only fully verified pages advance the persistent checkpoint.",
        );
      }
    });
  }
}
