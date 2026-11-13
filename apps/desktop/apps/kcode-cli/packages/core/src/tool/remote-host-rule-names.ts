import type { RemoteHostToolName } from "@fcode/shared";
import type { ToolEntry } from "./types.js";

const CURRENT_PREFIX = "mcp__koincode_remote_host__";
const LEGACY_PREFIX = "mcp__fcode_remote_host__";

export function legacyRemoteHostToolName(method: RemoteHostToolName): string {
  return `${LEGACY_PREFIX}${method}`;
}

/** The operation is attached only after the runtime verifies the built-in server. */
export function remoteHostRuleNames(toolName: string, entry: ToolEntry | undefined): readonly string[] {
  const method = entry?.remoteHostOperation?.method;
  if (!method || toolName !== `${CURRENT_PREFIX}${method}`) return [toolName];
  return [toolName, legacyRemoteHostToolName(method)];
}

export function isTurnToolDisallowed(
  toolName: string,
  entry: ToolEntry | undefined,
  disallowed: ReadonlySet<string> | undefined | null,
): boolean {
  return disallowed ? remoteHostRuleNames(toolName, entry).some((name) => disallowed.has(name)) : false;
}
