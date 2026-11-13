import type { RemoteHostSubmissionPort } from "@fcode/shared";
import type { IFCodeAgentService } from "../fcode-agent/fcodeAgent.js";

/** Runtime loss revokes the captured registration before a replacement can start. */
export function bindRemoteHostAgentLifecycle(source: Pick<IFCodeAgentService, "onAgentRuntimeLifecycle">,
  port: RemoteHostSubmissionPort, onError: (error: unknown) => void): { dispose(): void } {
  return source.onAgentRuntimeLifecycle?.((event) => {
    if (event.state !== "unavailable" || event.workspaceIdentity) return;
    const agent = port.getAgent(event.workspaceKey);
    if (agent) void agent.revoke().catch(onError);
  }) ?? { dispose() {} };
}
