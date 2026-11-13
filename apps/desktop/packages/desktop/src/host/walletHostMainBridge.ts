import { randomUUID } from "node:crypto";
import {
  WALLET_HOST_MAX_BYTES,
  WALLET_HOST_TIMEOUT_MS,
  walletHostHasCapacity,
  WALLET_HOST_IMAGE_READ_TIMEOUT_MS,
  WALLET_HOST_IMAGE_RELEASE_TIMEOUT_MS,
  walletHostCallSchema,
  walletHostModelCallSchema,
  walletHostImageReadSchema,
  walletHostImageReleaseSchema,
  walletHostReplySchema,
  walletHostMainResultSchema,
  walletHostAgentSchema,
  type WalletHostPort,
  type WalletHostReply,
  type WalletHostMainCommand,
} from "@fcode/shared";

/** Uses this Host's private parent port; image capabilities and chunks never enter model-visible results. */
export function createWalletHostMainBridge(
  post: (message: {
    type: "wallet-host-request";
    requestId: string;
    command: WalletHostMainCommand;
  }) => void,
): WalletHostPort & { handleResult(id: string, raw: unknown): void; dispose(): void } {
  const pending = new Map<string, { statusProbe: boolean; finish(value: WalletHostReply): void; cancel(): void }>();
  let closed = false;
  async function forward(raw: unknown, signal: AbortSignal, attachment: unknown,
    kind: "call" | "model-call" | "image-read" | "image-release"): Promise<WalletHostReply> {
      if (closed || signal.aborted)
        return { ok: false, code: "WALLET_UNAVAILABLE" };
      const agent = walletHostAgentSchema.safeParse(attachment);
      if (!agent.success) return { ok: false, code: "CLIENT_AUTHENTICATION_REQUIRED" };
      const operation = kind === "model-call" ? { kind, input: walletHostModelCallSchema.parse(raw), agent: agent.data } :
        kind === "call" ? { kind, input: walletHostCallSchema.parse(raw), agent: agent.data } :
        kind === "image-read" ? { kind, input: walletHostImageReadSchema.parse(raw), agent: agent.data } :
          { kind, input: walletHostImageReleaseSchema.parse(raw), agent: agent.data };
      const statusProbe = operation.kind === "model-call" && operation.input.method === "payment_wait_status";
      if (!walletHostHasCapacity(pending.values(), statusProbe))
        return { ok: false, code: "WALLET_CHANNEL_CAPACITY" };
      const { input } = operation;
      if (Buffer.byteLength(JSON.stringify({ input, agent: agent.data })) > WALLET_HOST_MAX_BYTES)
        return { ok: false, code: "REQUEST_TOO_LARGE" };
      const requestId = randomUUID();
      return new Promise<WalletHostReply>((resolve) => {
        let finished = false;
        const finish = (reply: WalletHostReply) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", cancel);
          pending.delete(requestId);
          resolve(reply);
        };
        const cancel = () => {
          try {
            post({
              type: "wallet-host-request",
              requestId: randomUUID(),
              command: { kind: "cancel", callId: input.callId },
            });
          } catch {
            /* The original operation remains unknown when Main cannot be reached. */
          }
          finish({ ok: false, code: "WALLET_REQUEST_CANCELED" });
        };
        const timeoutMs = (kind === "call" || kind === "model-call") ? WALLET_HOST_TIMEOUT_MS : kind === "image-read"
          ? WALLET_HOST_IMAGE_READ_TIMEOUT_MS : WALLET_HOST_IMAGE_RELEASE_TIMEOUT_MS;
        const timer = setTimeout(cancel, timeoutMs);
        timer.unref();
        pending.set(requestId, { statusProbe, finish, cancel });
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted || closed) {
          cancel();
          return;
        }
        try {
          post({
            type: "wallet-host-request",
            requestId,
            command: operation,
          });
        } catch {
          // A throwing transport cannot prove that Main did not receive the call.
          try {
            post({
              type: "wallet-host-request",
              requestId: randomUUID(),
              command: { kind: "cancel", callId: input.callId },
            });
          } catch {
            /* Main must retain unknown operation facts independently. */
          }
          finish({ ok: false, code: "WALLET_UNAVAILABLE" });
        }
      });
  }
  return {
    async modelCall(raw, signal, attachment) { return forward(raw, signal, attachment, "model-call"); },
    async call(raw, signal, attachment) { return forward(raw, signal, attachment, "call"); },
    async readImage(raw, signal, attachment) { return forward(raw, signal, attachment, "image-read"); },
    async releaseImage(raw, signal, attachment) { return forward(raw, signal, attachment, "image-release"); },
    registerAgent(raw) {
      const agent = walletHostAgentSchema.safeParse(raw);
      if (closed || !agent.success) return;
      try { post({ type: "wallet-host-request", requestId: randomUUID(), command: { kind: "agent-ready", agent: agent.data } }); }
      catch { /* Parent loss is independently fenced by the Main Host lifetime. */ }
    },
    releaseAgent(raw) {
      const agent = walletHostAgentSchema.safeParse(raw);
      if (closed || !agent.success) return;
      try {
        post({
          type: "wallet-host-request",
          requestId: randomUUID(),
          command: { kind: "agent-closed", agent: agent.data },
        });
      } catch {
        /* Parent loss is independently fenced by the Main Host lifetime. */
      }
    },
    handleResult(id, raw) {
      const entry = pending.get(id);
      if (!entry) return;
      try {
        if (Buffer.byteLength(JSON.stringify(raw)) > WALLET_HOST_MAX_BYTES) throw new Error("size");
        const reply = walletHostMainResultSchema.parse(raw);
        entry.finish(walletHostReplySchema.parse(reply));
      } catch {
        entry.finish({ ok: false, code: "WALLET_RESPONSE_INVALID" });
      }
    },
    dispose() {
      closed = true;
      for (const entry of pending.values()) entry.cancel();
    },
  };
}
