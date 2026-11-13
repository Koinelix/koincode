import { RemoteHostError, type RemoteHostControlPort } from "@fcode/shared";
import type { ToolHandler } from "../tool/types.js";

/** Releasing a call never cancels an already accepted execution permit. */
export function withRemoteHostCallCleanup(handler: ToolHandler, port: RemoteHostControlPort): ToolHandler {
  return async (input, context) => {
    if (!context.turnId) throw new RemoteHostError("permission_denied", "Remote Host requires the actual turn identity.", "authorization");
    let result: unknown; let failed = false; let primaryError: unknown;
    try { result = await handler(input, context); }
    catch (error) { failed = true; primaryError = error; }
    try {
      await port.control({ kind: "close-call", identity: { sessionId: String(context.sessionId), turnId: String(context.turnId), toolCallId: context.toolCallId } });
    } catch {
      if (!failed) throw new RemoteHostError("runtime_protocol_mismatch", "The Remote Host result was received but its call cleanup was not acknowledged. Review retained executions before repeating the operation.", "authorization");
    }
    if (failed) throw primaryError;
    return result;
  };
}
