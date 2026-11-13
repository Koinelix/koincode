import { fcodeProtocolMethods, walletHostCallSchema, walletHostModelCallSchema, walletHostCancelSchema, walletHostImageReadSchema, walletHostImageReleaseSchema,
  walletHostReplySchema, WALLET_HOST_MAX_BYTES, WALLET_HOST_TIMEOUT_MS, walletHostHasCapacity,
  WALLET_HOST_IMAGE_READ_TIMEOUT_MS, WALLET_HOST_IMAGE_RELEASE_TIMEOUT_MS,
  type WalletHostPort, type WalletHostReply } from "@fcode/shared";

/** One receiver per actual Agent connection; closing it never transfers work to a new generation. */
export function createWalletHostRequestReceiver(host?: WalletHostPort) {
  const active = new Map<string, { statusProbe: boolean; controller: AbortController; done: Promise<WalletHostReply> }>();
  let closed = false;
  const failure = (code: string): WalletHostReply => ({ ok: false, code });
  return {
    receive(method: string, raw: unknown): Promise<WalletHostReply | { stopped: boolean }> | undefined {
      if (method === fcodeProtocolMethods.walletHostCancel) {
        const cancel = walletHostCancelSchema.safeParse(raw);
        const pending = cancel.success ? active.get(cancel.data.callId) : undefined;
        pending?.controller.abort();
        return Promise.resolve({ stopped: !!pending });
      }
      if (method !== fcodeProtocolMethods.walletHostModelCall && method !== fcodeProtocolMethods.walletHostCall && method !== fcodeProtocolMethods.walletHostImageRead &&
        method !== fcodeProtocolMethods.walletHostImageRelease) return undefined;
      let operation;
      try {
        if (Buffer.byteLength(JSON.stringify(raw)) > WALLET_HOST_MAX_BYTES) throw new Error("size");
        operation = method === fcodeProtocolMethods.walletHostModelCall
          ? { kind: "model" as const, input: walletHostModelCallSchema.parse(raw) }
          : method === fcodeProtocolMethods.walletHostCall
          ? { kind: "call" as const, input: walletHostCallSchema.parse(raw) }
          : method === fcodeProtocolMethods.walletHostImageRead
            ? { kind: "read" as const, input: walletHostImageReadSchema.parse(raw) }
            : { kind: "release" as const, input: walletHostImageReleaseSchema.parse(raw) };
      } catch { return Promise.resolve(failure("INVALID_REQUEST")); }
      if (closed || !host) return Promise.resolve(failure("WALLET_UNAVAILABLE"));
      if (active.has(operation.input.callId)) return Promise.resolve(failure("REQUEST_CONFLICT"));
      const statusProbe = operation.kind === "model" && operation.input.method === "payment_wait_status";
      if (!walletHostHasCapacity(active.values(), statusProbe)) return Promise.resolve(failure("WALLET_CHANNEL_CAPACITY"));
      const controller = new AbortController();
      const timeoutMs = (operation.kind === "call" || operation.kind === "model") ? WALLET_HOST_TIMEOUT_MS : operation.kind === "read"
        ? WALLET_HOST_IMAGE_READ_TIMEOUT_MS : WALLET_HOST_IMAGE_RELEASE_TIMEOUT_MS;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref();
      const value = operation;
      const done = Promise.resolve().then(async (): Promise<WalletHostReply> => {
        if (closed || controller.signal.aborted) return failure("WALLET_REQUEST_CANCELED");
        const reply = walletHostReplySchema.parse(await (value.kind === "model"
          ? host.modelCall?.(value.input, controller.signal) ?? failure("WALLET_MODEL_CHANNEL_UNAVAILABLE")
          : value.kind === "call"
          ? host.call(value.input, controller.signal)
          : value.kind === "read"
            ? host.readImage?.(value.input, controller.signal) ?? failure("IMAGE_TRANSFER_UNAVAILABLE")
            : host.releaseImage?.(value.input, controller.signal) ?? failure("IMAGE_TRANSFER_UNAVAILABLE")));
        if (closed || controller.signal.aborted) return failure("WALLET_REQUEST_CANCELED");
        if (Buffer.byteLength(JSON.stringify(reply)) > WALLET_HOST_MAX_BYTES) return failure("RESPONSE_TOO_LARGE");
        return reply;
      }).catch(() => failure("WALLET_REQUEST_FAILED")).finally(() => {
        clearTimeout(timer); active.delete(value.input.callId);
      });
      active.set(value.input.callId, { statusProbe, controller, done });
      return done;
    },
    async close(): Promise<void> {
      closed = true;
      for (const entry of active.values()) entry.controller.abort();
      await Promise.allSettled([...active.values()].map((entry) => entry.done));
    },
  };
}
