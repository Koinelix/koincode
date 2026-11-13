import type { RuntimeContext } from "./runtimeContext.js";
import type { RequestEnvironment } from "./requestPorts.js";
import { newTransport } from "./transportState.js";
import type { ResponseRetentionOwner } from "./responseRetentionOwner.js";
import type { RequestStore } from "./requestStore.js";
import type { RequestHttp } from "./requestHttp.js";
import type { ClientHandle } from "./sessions.js";
import type { RequestRecord } from "../domain/requestModel.js";
import { requireWallet } from "../domain/errors.js";
import { acquireResponseCapacity } from "./responseBudget.js";

export async function beginRetention(retention: ResponseRetentionOwner | undefined, store: RequestStore,
  record: RequestRecord, phase: "initial" | "paid") {
  if (!retention) return undefined;
  const now = store.env.wall();
  return (await retention.journal.begin(record.requestId, phase, now,
    Math.min(record.expiresAt, now + 86400000))).retentionId;
}
export async function discardIncomplete(retention: ResponseRetentionOwner | undefined, store: RequestStore,
  id: string | undefined): Promise<void> {
  if (id && store.ctx.state.snapshot().transport?.retentions?.find(r => r.retentionId === id)?.state === "writing")
    await retention?.cleanup(id).catch(() => {});
}
export async function recoverRetainedResponse(store: RequestStore, http: RequestHttp,
  retention: ResponseRetentionOwner, handle: ClientHandle, id: string, signal: AbortSignal): Promise<void> {
  const record = store.owned(handle, id), frozen = await store.frozen(record);
  signal.throwIfAborted();
  store.assertRetainedCurrent(handle, record, frozen);
  const history = store.ctx.state.snapshot().transport?.retentions ?? [];
  const saved = history.filter(r =>
    r.requestId === id && r.epoch === record.epoch && r.state === "ready")
    .at(-1);
  requireWallet(saved, "RESPONSE_RETENTION_UNAVAILABLE", "No complete retained response is available.");
  if (record.responseRetentionId === saved.retentionId) {
    await retention.cleanup(saved.retentionId);
    return;
  }
  if (history.filter(r => r.requestId === id && r.epoch === record.epoch).at(-1) !== saved) {
    await retention.cleanup(saved.retentionId);
    return;
  }
  if (record.responseRetentionId && history.findIndex(r => r.retentionId === record.responseRetentionId) > history.indexOf(saved)) {
    await retention.cleanup(saved.retentionId);
    return;
  }
  const reservation = acquireResponseCapacity(store.env.blobs);
  try { await http.recover(handle, record, frozen, saved.retentionId, signal, reservation); }
  finally { reservation.release(); }
  return;
}

export async function initializeRequestTransport(ctx: RuntimeContext, env: RequestEnvironment): Promise<void> {
    requireWallet(!env.retainedBlobs || ["putRetained", "get", "removeRetained"].every(key =>
      typeof (env.retainedBlobs as unknown as Record<string, unknown>)[key] === "function"),
    "INVALID_REQUEST_CONFIGURATION", "Retained storage requires all lifecycle operations.");
    requireWallet(env.retainedBlobs || !ctx.state.snapshot().transport?.retentions?.some(r => r.state !== "deleted"),
      "INVALID_REQUEST_CONFIGURATION", "Existing retained responses require their lifecycle adapter.");
    requireWallet(
      typeof env.authorize === "function" &&
        typeof env.checkOutbound === "function" &&
        typeof env.blobs?.reserveResponse === "function",
      "INVALID_REQUEST_CONFIGURATION",
      "Trusted outbound authorization, synchronous checks and response capacity are required.",
    );
    await ctx.state.mutate((state) => {
      state.transport ??= newTransport(state.managementEpoch);
      if (state.transport.epoch !== state.managementEpoch) {
        state.transport.historyComplete = false;
        return;
      }
      for (const r of state.transport.requests) {
        r.reconciliationPending = false;
        if (r.transportStatus === "running") {
          r.transportStatus = "unknown";
          r.diagnosticCode = "HTTP_UNKNOWN";
        }
      }
    });
}
