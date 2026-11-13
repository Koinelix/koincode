import type { X402RequestInput, HostPaymentInput } from "../domain/requestModel.js";
import { isWalletQueryTool } from "./hostTools.js";
import {
  hostRequestHasCapacity,
  decodeHostRequest,
  encodeHostRequest,
  keys,
  record,
  requestCode,
  hostRequestError,
  type HostRequestClient,
  type HostRequestMessagePort,
} from "./hostRequestProtocol.js";

/** Bind only an already authenticated SDK client; no management or registration route exists here. */
export function serveHostWalletRequests(port: HostRequestMessagePort, client: HostRequestClient) {
  let closed = false,
    lastId = 0;
  let unsubscribe = () => {};
  const active = new Map<number, { statusProbe: boolean; controller: AbortController; done: Promise<void> }>();
  const work = new Set<Promise<void>>();
  let drain: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (drain) return drain;
    closed = true;
    let finished!: () => void;
    drain = new Promise<void>((resolve) => {
      finished = resolve;
    });
    try {
      unsubscribe();
    } catch {
      /* Cancellation must still reach every pending call. */
    }
    for (const entry of active.values()) entry.controller.abort(hostRequestError());
    try {
      port.close();
    } catch {
      /* The endpoint is already unusable. */
    }
    void Promise.all(work).then(finished);
    return drain;
  };
  const receive = (raw: unknown) => {
    if (closed) return;
    try {
      const message = decodeHostRequest(raw),
        id = message.id as number;
      if (message.type === "cancel") {
        if (!keys(message, ["version", "type", "id"]) || id > lastId) throw hostRequestError();
        active.get(id)?.controller.abort(hostRequestError("WALLET_REQUEST_CANCELED"));
        return;
      }
      const request =
        message.type === "request" &&
        keys(message, ["version", "type", "id", "source", "input"]) &&
        typeof message.source === "string" &&
        /^[0-9a-f]{64}$/.test(message.source);
      const tool =
        message.type === "tool" &&
        keys(message, ["version", "type", "id", "name", "input"]) &&
        isWalletQueryTool(message.name);
      const hostPrepare = message.type === "host-payment-prepare" &&
        keys(message, ["version", "type", "id", "source", "input"]) &&
        typeof message.source === "string" && /^[0-9a-f]{64}$/.test(message.source);
      const hostSubmit = message.type === "host-payment-submit" &&
        keys(message, ["version", "type", "id", "input"]) && record(message.input) &&
        keys(message.input, ["requestId", "requestDigest"]) &&
        typeof message.input.requestId === "string" && typeof message.input.requestDigest === "string";
      const paymentClient = message.type === "payment-client" && keys(message, ["version", "type", "id", "name", "input"]) &&
        typeof message.name === "string" && message.name.length <= 64;
      const statusProbe = paymentClient && message.name === "model_admission_status";
      if (
        (!request && !tool && !hostPrepare && !hostSubmit && !paymentClient) ||
        id !== lastId + 1 ||
        !record(message.input) ||
        !hostRequestHasCapacity(active.values(), statusProbe)
      )
        throw hostRequestError();
      lastId = id;
      const controller = new AbortController();
      // Register before entering the SDK, so synchronous cancellation cannot miss this call.
      const done = Promise.resolve()
        .then(async () => {
          let reply: unknown;
          try {
            controller.signal.throwIfAborted();
            const value = paymentClient
              ? await (() => {
                  if (!client.callPaymentClient) throw hostRequestError("TOOL_NOT_FOUND");
                  return client.callPaymentClient(message.name as string, message.input as Record<string, unknown>, controller.signal);
                })()
              : hostPrepare
              ? await (() => {
                  if (!client.prepareHostPayment) throw hostRequestError("TOOL_NOT_FOUND");
                  return client.prepareHostPayment(message.input as unknown as HostPaymentInput,
                    message.source as string, controller.signal);
                })()
              : hostSubmit
              ? await (() => {
                  if (!client.submitHostPayment) throw hostRequestError("TOOL_NOT_FOUND");
                  const input = message.input as Record<string, string>;
                  return client.submitHostPayment(input.requestId!, input.requestDigest!, controller.signal);
                })()
              : tool
              ? await (() => {
                  if (!client.callTool) throw hostRequestError("TOOL_NOT_FOUND");
                  return client.callTool(
                    message.name as string,
                    message.input as Record<string, unknown>,
                    controller.signal,
                  );
                })()
              : await client.request(
                  message.input as unknown as X402RequestInput,
                  message.source as string,
                  controller.signal,
                );
            reply = { version: 1, id, ok: true, value };
          } catch (error) {
            reply = { version: 1, id, ok: false, code: requestCode(error) };
          }
          // SDK settlement releases capacity before a synchronous peer can reuse it.
          // Keep response publication in work until its own finalizer completes.
          active.delete(id);
          if (!closed) {
            try {
              const encoded = encodeHostRequest(reply);
              if (!closed) port.send(encoded);
            } catch {
              void close();
            }
          }
        })
        .finally(() => {
          active.delete(id);
          work.delete(done);
        });
      active.set(id, { statusProbe, controller, done });
      work.add(done);
    } catch {
      void close();
    }
  };
  try {
    unsubscribe = port.subscribe(receive, () => {
      void close();
    });
    if (closed) unsubscribe();
  } catch {
    void close();
    throw hostRequestError();
  }
  return Object.freeze({ close });
}
