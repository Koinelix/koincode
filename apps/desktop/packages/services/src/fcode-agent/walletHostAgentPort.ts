import type { WalletHostAgent, WalletHostPort } from "@fcode/shared";

/** Host-owned process attachment. Agent messages never select their own instance or workspace. */
export function bindWalletHostAgent(host: WalletHostPort, current: () => boolean,
  readIdentity: () => Promise<WalletHostAgent>): WalletHostPort {
  if (host.registerAgent) {
    // Announce an already-created CLI, without starting a process or executing a wallet tool.
    void Promise.resolve().then(async () => {
      const identity = await readIdentity();
      if (current()) host.registerAgent!({ workspaceKey: identity.workspaceKey,
        identity: identity.identity, generation: identity.generation });
    }).catch(() => { /* A missing or retired process cannot establish wallet attachment. */ });
  }
  return {
    async modelCall(input, signal) {
      if (!current() || signal.aborted) return { ok: false, code: "CLIENT_AUTHENTICATION_REQUIRED" };
      const identity = await readIdentity();
      if (!current() || signal.aborted) return { ok: false, code: "CLIENT_AUTHENTICATION_REQUIRED" };
      return host.modelCall?.(input, signal, { workspaceKey: identity.workspaceKey,
        identity: identity.identity, generation: identity.generation }) ?? { ok: false, code: "WALLET_MODEL_CHANNEL_UNAVAILABLE" };
    },
    async call(input, signal) {
      if (!current() || signal.aborted) return { ok: false, code: "CLIENT_AUTHENTICATION_REQUIRED" };
      const identity = await readIdentity();
      if (!current() || signal.aborted) return { ok: false, code: "CLIENT_AUTHENTICATION_REQUIRED" };
      return host.call(input, signal, { workspaceKey: identity.workspaceKey,
        identity: identity.identity, generation: identity.generation });
    },
    async readImage(input, signal) {
      if (!current() || signal.aborted) return { ok: false, code: "CLIENT_AUTHENTICATION_REQUIRED" };
      const identity = await readIdentity();
      if (!current() || signal.aborted) return { ok: false, code: "CLIENT_AUTHENTICATION_REQUIRED" };
      return host.readImage?.(input, signal, { workspaceKey: identity.workspaceKey,
        identity: identity.identity, generation: identity.generation }) ?? { ok: false, code: "IMAGE_TRANSFER_UNAVAILABLE" };
    },
    async releaseImage(input, signal) {
      if (!current() || signal.aborted) return { ok: false, code: "CLIENT_AUTHENTICATION_REQUIRED" };
      const identity = await readIdentity();
      if (!current() || signal.aborted) return { ok: false, code: "CLIENT_AUTHENTICATION_REQUIRED" };
      return host.releaseImage?.(input, signal, { workspaceKey: identity.workspaceKey,
        identity: identity.identity, generation: identity.generation }) ?? { ok: false, code: "IMAGE_TRANSFER_UNAVAILABLE" };
    },
  };
}
