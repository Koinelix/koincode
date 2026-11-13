import { fcodeProtocolMethods, walletHostCallSchema, walletHostModelCallSchema, walletHostReplySchema, walletHostImageReadSchema, walletHostImageReleaseSchema,
  WALLET_HOST_MAX_BYTES, WALLET_HOST_TIMEOUT_MS, walletHostHasCapacity, WALLET_HOST_IMAGE_READ_TIMEOUT_MS,
  WALLET_HOST_IMAGE_RELEASE_TIMEOUT_MS, type WalletHostPort } from "@fcode/shared";
import { z } from "zod";
import { requireSession, type FCodeProtocolAgentServerContext, type FCodeProtocolSessionRecord } from "./server-types.js";

/** Reverse RPC runs on the existing private Agent transport, never a model-created socket. */
export function createProtocolWalletHost(context: FCodeProtocolAgentServerContext, sessionId: string,
  expectedSession: () => FCodeProtocolSessionRecord | undefined): WalletHostPort {
  const pending = new Map<string, { statusProbe: boolean }>();
  async function send(input: { callId: string; invocation: { sessionId: string } },
    signal: AbortSignal, method: typeof fcodeProtocolMethods.walletHostCall | typeof fcodeProtocolMethods.walletHostModelCall |
      typeof fcodeProtocolMethods.walletHostImageRead | typeof fcodeProtocolMethods.walletHostImageRelease) {
    const statusProbe = method === fcodeProtocolMethods.walletHostModelCall && "method" in input && input.method === "payment_wait_status";
    const session = requireSession(context, sessionId);
    if (session !== expectedSession() || session.workspace.workspaceIdentity || input.invocation.sessionId !== sessionId ||
      signal.aborted || pending.has(input.callId))
      return { ok: false as const, code: "CLIENT_AUTHENTICATION_REQUIRED" };
    if (!walletHostHasCapacity(pending.values(), statusProbe)) return { ok: false as const, code: "WALLET_CHANNEL_CAPACITY" };
    if (Buffer.byteLength(JSON.stringify(input)) > WALLET_HOST_MAX_BYTES)
      return { ok: false as const, code: "REQUEST_TOO_LARGE" };
    pending.set(input.callId, { statusProbe });
    const cancel = () => {
      void context.requestClient(fcodeProtocolMethods.walletHostCancel,
        { version: 1, callId: input.callId }, z.object({ stopped: z.boolean() }).strict(),
        { timeoutMs: 5000 }).catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      const timeoutMs = (method === fcodeProtocolMethods.walletHostCall || method === fcodeProtocolMethods.walletHostModelCall) ? WALLET_HOST_TIMEOUT_MS :
        method === fcodeProtocolMethods.walletHostImageRead ? WALLET_HOST_IMAGE_READ_TIMEOUT_MS : WALLET_HOST_IMAGE_RELEASE_TIMEOUT_MS;
      return await context.requestClient(method, input, walletHostReplySchema, { signal, timeoutMs });
    } finally {
      signal.removeEventListener("abort", cancel);
      pending.delete(input.callId);
    }
  }
  return {
    async modelCall(raw, signal) { return send(walletHostModelCallSchema.parse(raw), signal, fcodeProtocolMethods.walletHostModelCall); },
    async call(raw, signal) {
      return send(walletHostCallSchema.parse(raw), signal, fcodeProtocolMethods.walletHostCall);
    },
    async readImage(raw, signal) { return send(walletHostImageReadSchema.parse(raw), signal, fcodeProtocolMethods.walletHostImageRead); },
    async releaseImage(raw, signal) { return send(walletHostImageReleaseSchema.parse(raw), signal, fcodeProtocolMethods.walletHostImageRelease); },
  };
}
