import { inheritedParentSession } from "./trace-parent-session.js";
import type { TraceContext } from "@fcode/contracts";
import type { ToolExecutionContext } from "../types.js";

const WEBSEARCH_TOOL_NAME = "WebSearch";

export function webSearchTraceFromContext(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
    attributes: {
      ...inheritedParentSession(context),
      toolCallId: context.toolCallId,
      toolName: WEBSEARCH_TOOL_NAME,
    },
  };
}
