import { randomUUID } from "node:crypto";
import {
  HostResponseTypes, RemoteHostError, remoteHostControlResultSchema, remoteHostAgentCredentialsSchema, remoteHostExecutionSupport,
  FCODE_REMOTE_HOST_BROKER_SOCKET_ENV_KEY, FCODE_REMOTE_HOST_BROKER_TOKEN_ENV_KEY,
  type RemoteHostControlCommand, type RemoteHostControlResult, type RemoteHostSubmissionPort,
  type RemoteHostAgentPort, REMOTE_HOST_LIMITS,
} from "@fcode/shared";

/** This private parent-port bridge never listens on a model-accessible socket. */
export function createRemoteHostMainBridge(postToMain: (message: {
  type: typeof HostResponseTypes.RemoteHostControlRequest; requestId: string; command: RemoteHostControlCommand;
}) => void, platform = process.platform): RemoteHostSubmissionPort & { handleResult(id: string, result: RemoteHostControlResult): void; dispose(): Promise<void> } {
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  const agents = new Map<string, RemoteHostAgentPort>();
  let disposed = false;
  const send = (command: RemoteHostControlCommand): Promise<unknown> => {
    if (disposed) return Promise.reject(new RemoteHostError("canceled", "The Remote Host bridge has stopped."));
    if (pending.size >= 512) return Promise.reject(new RemoteHostError("storage_busy", "Too many private Remote Host requests are pending."));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new RemoteHostError("connection_timeout", "The private Remote Host request timed out.")); }, REMOTE_HOST_LIMITS.maxExecutionMs);
      timer.unref(); pending.set(requestId, { resolve, reject, timer });
      try { postToMain({ type: HostResponseTypes.RemoteHostControlRequest, requestId, command }); }
      catch (error) { clearTimeout(timer); pending.delete(requestId); reject(error); }
    });
  };
  return {
    async getRuntimeEnv(context): Promise<Record<string, string>> {
      if (context.workspaceIdentity || !remoteHostExecutionSupport(platform).available) return {};
      await agents.get(context.workspaceKey)?.revoke();
      const clientInstanceId = randomUUID();
      const opened = remoteHostAgentCredentialsSchema.parse(await send({ kind: "open-agent", clientInstanceId,
        workspaceKey: context.workspaceKey, workspaceRoot: context.workspacePath, agentGeneration: randomUUID() }));
      let tail: Promise<unknown> = Promise.resolve();
      const control: RemoteHostAgentPort["control"] = (command) => {
        // Lifecycle cancellation must not wait behind a stalled preflight.
        if (command.kind === "close-session") return send({ ...command, clientInstanceId });
        const next = tail.then(() => send({ ...command, clientInstanceId }));
        tail = next.catch(() => {}); return next;
      };
      const agent: RemoteHostAgentPort = {
        control,
        registerSubmission: async (selectionId, submissionId) => { await send({ kind: "register-submission", clientInstanceId, selectionId, submissionId }); },
        async revoke() {
          if (agents.get(context.workspaceKey) === agent) agents.delete(context.workspaceKey);
          await send({ kind: "revoke-agent", clientInstanceId });
        },
      };
      agents.set(context.workspaceKey, agent);
      return { [FCODE_REMOTE_HOST_BROKER_SOCKET_ENV_KEY]: opened.socket, [FCODE_REMOTE_HOST_BROKER_TOKEN_ENV_KEY]: opened.token };
    },
    getAgent: (workspaceKey) => agents.get(workspaceKey),
    async revokeSession(workspaceKey, sessionId) { await agents.get(workspaceKey)?.control({ kind: "close-session", sessionId }); },
    async revokeWorkspace(workspaceKey) { await agents.get(workspaceKey)?.revoke(); },
    async beginPluginMutation(workspaceKey) {
      const mutationId = randomUUID(); await send({ kind: "begin-plugin-mutation", mutationId, ...(workspaceKey ? { workspaceKey } : {}) }); return mutationId;
    },
    async endPluginMutation(mutationId) { await send({ kind: "end-plugin-mutation", mutationId }); },
    handleResult(id, raw) {
      const item = pending.get(id); if (!item) return;
      pending.delete(id); clearTimeout(item.timer);
      const result = remoteHostControlResultSchema.safeParse(raw);
      if (!result.success) item.reject(new RemoteHostError("invalid_request", "The private Remote Host response is invalid."));
      else if (result.data.ok) item.resolve(result.data.value);
      else item.reject(new RemoteHostError(result.data.error.code, result.data.error.message, result.data.error.stage));
    },
    async dispose() {
      if (disposed) return;
      await Promise.allSettled([...agents.values()].map((agent) => agent.revoke())); disposed = true;
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new RemoteHostError("canceled", "The Remote Host bridge stopped.")); }
      pending.clear(); agents.clear();
    },
  };
}
