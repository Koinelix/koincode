import type { McpServerConfig, PluginLoadOutcome } from "@fcode/contracts";
import { registerRemoteHostMcpConfig, REMOTE_HOST_MCP_COMMAND,
  REMOTE_HOST_MCP_SERVER, isCompatibleRemoteHostPlugin } from "@fcode/shared";
import { isVerifiedRemoteHostPlugin } from "@fcode/adapters/plugins";
import { verifyRemoteHostPluginRoot } from "./bundled-plugins.js";
import { officialPluginHostPrefixArgs } from "./official-plugin-runtime.js";

export function resolveBuiltInRemoteHostMcpServers(outcome: Pick<PluginLoadOutcome, "plugins">, cwd: string): Record<string, McpServerConfig> {
  const plugin = outcome.plugins.find((candidate) => isCompatibleRemoteHostPlugin(candidate) &&
    isVerifiedRemoteHostPlugin(candidate) && verifyRemoteHostPluginRoot(candidate.rootPath));
  const prefix = officialPluginHostPrefixArgs();
  if (!plugin || !prefix) return {};
  const config: Extract<McpServerConfig, { type: "stdio" }> = { type: "stdio", command: process.execPath,
    args: [...prefix.slice(0, -1), REMOTE_HOST_MCP_COMMAND], cwd, source: { kind: "builtin" }, isolation: "workspace", protocolVersion: "legacy",
    env: { ELECTRON_RUN_AS_NODE: "1" }, timeoutMs: 120_000 };
  return registerRemoteHostMcpConfig(config) ? { [REMOTE_HOST_MCP_SERVER]: config } : {};
}
