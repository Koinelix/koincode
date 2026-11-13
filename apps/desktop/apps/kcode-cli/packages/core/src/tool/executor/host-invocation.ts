import { beginHostToolInvocation } from "@fcode/contracts";
import type { ToolExecutionContext } from "../types.js";

/** Only the real executor wraps its admitted handler; output never carries this witness. */
export async function withHostToolInvocation<T>(
  toolName: string,
  context: ToolExecutionContext,
  execute: (context: ToolExecutionContext) => Promise<T>,
): Promise<T> {
  const invocation = beginHostToolInvocation(
    {
      traceId: context.traceId,
      spanId: context.spanId ?? "",
      sessionId: context.sessionId,
      turnId: context.turnId ?? "",
      toolCallId: context.toolCallId,
      toolName,
      runtimeScope: context.runtimeScope ?? "main",
    },
    context.abortSignal,
  );
  try {
    return await execute({ ...context, hostInvocation: invocation?.token });
  } finally {
    invocation?.close();
  }
}
