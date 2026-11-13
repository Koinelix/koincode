import type { ToolExecutionContext } from "../types.js";

/**
 * Rebuilt tool traces keep the runtime-provided parent session so auxiliary model calls made by a
 * subagent tool stay attributable to the session that owns the wallet binding.
 */
export function inheritedParentSession(context: Pick<ToolExecutionContext, "traceContext">): { parentSessionId?: string } {
  const value = context.traceContext?.attributes?.parentSessionId;
  return typeof value === "string" && value.length > 0 ? { parentSessionId: value } : {};
}
