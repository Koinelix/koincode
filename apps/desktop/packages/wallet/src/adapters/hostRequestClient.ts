import type { RequestView, X402RequestInput, HostPaymentInput, HostPaymentMaterial, HostPaymentPrepared } from "../domain/requestModel.js";
import { REQUEST_ACTION_TIMEOUT_MS } from "../domain/requestTiming.js";
import { isWalletQueryTool } from "./hostTools.js";
import {
  hostRequestHasCapacity,
  HOST_REQUEST_MESSAGE_BYTES,
  decodeHostRequest,
  encodeHostRequest,
  keys,
  record,
  hostRequestError,
  type HostRequestClient,
  type HostRequestMessagePort,
} from "./hostRequestProtocol.js";
interface Pending {
  readonly statusProbe: boolean;
  readonly request: boolean;
  readonly payment: boolean;
  readonly preparePayment: boolean;
  finish(error?: Error, result?: unknown): void;
}
/** No automatic retry: a lost reply leaves the original durable operation authoritative. */
export function createHostWalletChannelClient(
  port: HostRequestMessagePort,
): HostRequestClient & {
  callTool(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  prepareHostPayment(input: HostPaymentInput, source: string, signal?: AbortSignal): Promise<HostPaymentPrepared>;
  submitHostPayment(requestId: string, requestDigest: string, signal?: AbortSignal): Promise<HostPaymentMaterial>;
  callPaymentClient(method: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  close(): void;
  drain(): Promise<void>;
} {
  let closed = false,
    nextId = 0;
  let unsubscribe = () => {};
  const pending = new Map<number, Pending>();
  const drains = new Set<{ resolve(): void; reject(error: Error): void }>();
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      unsubscribe();
    } catch {
      /* Cancellation must still reach every pending call. */
    }
    for (const entry of pending.values()) entry.finish(hostRequestError());
    pending.clear();
    for (const waiter of drains) waiter.reject(hostRequestError());
    drains.clear();
    try {
      port.close();
    } catch {
      /* No usable endpoint remains. */
    }
  };
  const receive = (raw: unknown) => {
    if (closed) return;
    try {
      const reply = decodeHostRequest(raw),
        id = reply.id as number,
        entry = pending.get(id);
      if (!entry || typeof reply.ok !== "boolean") throw hostRequestError();
      if (reply.ok) {
        if (
          !keys(reply, ["version", "id", "ok", "value"]) ||
          (entry.request &&
            (!record(reply.value) ||
              typeof reply.value.requestId !== "string" ||
              typeof reply.value.operationId !== "string" ||
              typeof reply.value.transportStatus !== "string" ||
              typeof reply.value.paymentStatus !== "string")) ||
          (entry.preparePayment && (!record(reply.value) || typeof reply.value.walletFrozenDigest !== "string" ||
            !/^[0-9a-f]{64}$/.test(reply.value.walletFrozenDigest) || typeof reply.value.walletInputDigest !== "string" ||
            !/^[0-9a-f]{64}$/.test(reply.value.walletInputDigest) || !record(reply.value.walletClient) ||
            !keys(reply.value.walletClient, ["ownerId", "clientId", "sessionId", "generation", "identityLevel", "managementEpoch"]) ||
            typeof reply.value.walletClient.ownerId !== "string" || typeof reply.value.walletClient.clientId !== "string" ||
            typeof reply.value.walletClient.sessionId !== "string" || !Number.isSafeInteger(reply.value.walletClient.generation) ||
            !["verified", "token_only"].includes(String(reply.value.walletClient.identityLevel)) ||
            typeof reply.value.walletClient.managementEpoch !== "string" || !record(reply.value.walletCreatedBy) ||
            !keys(reply.value.walletCreatedBy, ["sessionId", "generation"]) ||
            typeof reply.value.walletCreatedBy.sessionId !== "string" || !Number.isSafeInteger(reply.value.walletCreatedBy.generation))) ||
          (entry.payment && (!record(reply.value) || !keys(reply.value, ["intentId", "paymentHeader"]) ||
            typeof reply.value.intentId !== "string" || typeof reply.value.paymentHeader !== "string" ||
            reply.value.paymentHeader.length === 0 || reply.value.paymentHeader.length > 65536))
        )
          throw hostRequestError();
        entry.finish(undefined, reply.value);
      } else {
        if (
          !keys(reply, ["version", "id", "ok", "code"]) ||
          typeof reply.code !== "string" ||
          !/^[A-Z][A-Z0-9_]{0,79}$/.test(reply.code)
        )
          throw hostRequestError();
        entry.finish(hostRequestError(reply.code));
      }
      pending.delete(id);
      if (pending.size === 0) {
        for (const waiter of drains) waiter.resolve();
        drains.clear();
      }
    } catch {
      close();
    }
  };
  try {
    unsubscribe = port.subscribe(receive, close);
    if (closed) unsubscribe();
  } catch {
    close();
    throw hostRequestError();
  }
  async function invoke(
    input: unknown,
    source: string | undefined,
    signal?: AbortSignal,
    toolName?: string,
    privateAction?: "prepare" | "submit" | "client",
  ): Promise<unknown> {
    if (closed) throw hostRequestError();
    if (signal?.aborted) throw hostRequestError("WALLET_REQUEST_CANCELED");
    const statusProbe = privateAction === "client" && toolName === "model_admission_status";
    if (!hostRequestHasCapacity(pending.values(), statusProbe) || nextId >= Number.MAX_SAFE_INTEGER)
      throw hostRequestError("WALLET_CHANNEL_CAPACITY");
    if (toolName !== undefined && privateAction !== "client" && !isWalletQueryTool(toolName))
      throw hostRequestError("TOOL_NOT_FOUND");
    if (toolName === undefined && privateAction !== "submit" && (typeof source !== "string" || !/^[0-9a-f]{64}$/.test(source)))
      throw hostRequestError("OPERATION_CONTEXT_REQUIRED");
    // Cloning/serialization can execute input getters. Admit only after they finish.
    const body = encodeHostRequest(structuredClone(input));
    if (closed) throw hostRequestError();
    if (signal?.aborted) throw hostRequestError("WALLET_REQUEST_CANCELED");
    if (!hostRequestHasCapacity(pending.values(), statusProbe) || nextId >= Number.MAX_SAFE_INTEGER)
      throw hostRequestError("WALLET_CHANNEL_CAPACITY");
    const id = nextId + 1;
    // Only validated primitives and serialized JSON remain; no caller code runs here.
    const encoded = privateAction === "client"
        ? `{"version":1,"type":"payment-client","id":${id},"name":${JSON.stringify(toolName)},"input":${body}}`
        : privateAction === "prepare"
        ? `{"version":1,"type":"host-payment-prepare","id":${id},"source":"${source}","input":${body}}`
        : privateAction === "submit"
        ? `{"version":1,"type":"host-payment-submit","id":${id},"input":${body}}`
        : toolName === undefined
        ? `{"version":1,"type":"request","id":${id},"source":"${source}","input":${body}}`
        : `{"version":1,"type":"tool","id":${id},"name":${JSON.stringify(toolName)},"input":${body}}`;
    if (Buffer.byteLength(encoded) > HOST_REQUEST_MESSAGE_BYTES)
      throw hostRequestError("REQUEST_TOO_LARGE");
    return await new Promise<unknown>((resolve, reject) => {
      let settled = false,
        sent = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(value!);
      };
      const cancel = (code: string) => {
        finish(hostRequestError(code));
        // Retain the slot until the server settles: cancellation is not completion.
        if (sent && !closed) {
          try {
            port.send(encodeHostRequest({ version: 1, type: "cancel", id }));
          } catch {
            close();
          }
        }
      };
      const abort = () => cancel("WALLET_REQUEST_CANCELED");
      timer = setTimeout(() => cancel("WALLET_REQUEST_TIMEOUT"), REQUEST_ACTION_TIMEOUT_MS);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      pending.set(id, { statusProbe, finish, request: toolName === undefined && privateAction !== "submit", payment: privateAction === "submit", preparePayment: privateAction === "prepare" });
      nextId = id;
      sent = true;
      try {
        port.send(encoded);
      } catch {
        close();
      }
    });
  }
  return Object.freeze({
    close,
    drain: () => closed ? Promise.reject(hostRequestError()) : pending.size === 0 ? Promise.resolve()
      : new Promise<void>((resolve, reject) => { drains.add({ resolve, reject }); }),
    request: (input: X402RequestInput, source: string, signal?: AbortSignal) =>
      invoke(input, source, signal) as Promise<RequestView>,
    prepareHostPayment: (input: HostPaymentInput, source: string, signal?: AbortSignal) =>
      invoke(input, source, signal, undefined, "prepare") as Promise<HostPaymentPrepared>,
    submitHostPayment: (requestId: string, requestDigest: string, signal?: AbortSignal) =>
      invoke({ requestId, requestDigest }, undefined, signal, undefined, "submit") as Promise<HostPaymentMaterial>,
    callPaymentClient: (method: string, input: Record<string, unknown>, signal?: AbortSignal) =>
      invoke(input, undefined, signal, method, "client"),
    callTool: (name: string, input: Record<string, unknown>, signal?: AbortSignal) =>
      invoke(input, undefined, signal, name),
  });
}
