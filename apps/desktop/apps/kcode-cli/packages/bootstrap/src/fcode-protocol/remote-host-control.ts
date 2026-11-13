import { SessionEventType, type SessionEvent } from "@fcode/contracts";
import { getCapturedRemoteHostBrokerCredentials, fcodeProtocolMethods, remoteHostControlResultSchema, RemoteHostError,
  type RemoteHostControlPort } from "@fcode/shared";
import { mapComputerUseOperationEvent } from "./computer-use-operation-event.js";
import type { FCodeProtocolAgentServerContext, FCodeProtocolSessionRecord } from "./server-types.js";

const controls = new WeakMap<FCodeProtocolAgentServerContext, RemoteHostControlPort>();
export function protocolRemoteHostControl(context: FCodeProtocolAgentServerContext): RemoteHostControlPort | undefined {
  if (!getCapturedRemoteHostBrokerCredentials()) return undefined;
  let port = controls.get(context);
  if (!port) {
    let tail: Promise<unknown> = Promise.resolve();
    port = { control(command) {
      const next = tail.then(async () => {
        const result = await context.requestClient(fcodeProtocolMethods.remoteHostControl, command, remoteHostControlResultSchema, { timeoutMs: 120_000 });
        if (!result.ok) throw new RemoteHostError(result.error.code, result.error.message, result.error.stage);
        return result.value;
      });
      tail = next.catch(() => {}); return next;
    } };
    controls.set(context, port);
  }
  return port;
}

/** Called from the actual session event source, never from model text or restored history. */
export function forwardRemoteHostLifecycle(context: FCodeProtocolAgentServerContext, record: FCodeProtocolSessionRecord, event: SessionEvent): void {
  if (record.parentSessionId) return;
  const port = protocolRemoteHostControl(context); if (!port) return;
  const mapped = mapComputerUseOperationEvent(event); if (!mapped) return;
  const payload = event.payload as Record<string, unknown>;
  let work: Promise<unknown> | undefined;
  if (mapped.kind === "turn-started" && mapped.messageId && mapped.inputId) {
    work = port.control({ kind: "start-turn", sessionId: mapped.sessionId, turnId: mapped.turnId, messageId: mapped.messageId,
      inputId: mapped.inputId, traceId: String(event.traceId), humanUser: mapped.humanUser === true, runtimeScope: "main" });
  } else if (mapped.kind === "turn-completed" || mapped.kind === "turn-failed") {
    work = port.control({ kind: "close-turn", sessionId: mapped.sessionId, turnId: mapped.turnId,
      reason: mapped.kind === "turn-failed" ? "failed" : event.type === SessionEventType.TurnComplete && payload.resultType === "cancelled" ? "stopped" : "completed" });
  }
  // A failed registration never authorizes a call; the broker rejects all subsequent dependent work.
  void work?.catch(() => {});
}
