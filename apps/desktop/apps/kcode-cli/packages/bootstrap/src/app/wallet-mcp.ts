import { randomUUID } from "node:crypto";
import { readHostToolInvocationContext, type McpPort, type McpServerConfig,
  type McpToolDescriptor, type McpServerStatus, type McpCallToolRequest,
  type McpCallToolOptions } from "@fcode/contracts";
import { WALLET_HOST_SERVER, WALLET_HOST_TIMEOUT_MS, WALLET_HOST_MAX_BYTES, WALLET_HOST_MAX_PENDING, WALLET_HOST_PLUGIN_ID,
  walletHostCallSchema, walletHostReplySchema, type WalletHostPort } from "@fcode/shared";
import { walletMcpTools as legacyWalletMcpTools } from "@koincode/wallet/host";
import type { PluginLoadOutcome } from "@fcode/contracts";
import { verifyWalletPluginRoot } from "./bundled-plugins.js";
import type { ToolArtifactStorePort } from "@fcode/contracts";
import { publishClientArtifacts } from "./client-artifacts.js";
import { walletClientTool } from "./wallet-client-tool.js";

const walletMcpTools = [...legacyWalletMcpTools.filter(tool =>
  !["x402_request", "x402_recover_response", "x402_export_response"].includes(tool.name)), walletClientTool];

export function resolveWalletMcpBinding(plugins: Pick<PluginLoadOutcome, "plugins">,
  sessionId: string, host: WalletHostPort | undefined) {
  if (!host || !plugins.plugins.some((plugin) => plugin.enabled && plugin.source === "official" &&
    plugin.id === WALLET_HOST_PLUGIN_ID && verifyWalletPluginRoot(plugin.rootPath))) return undefined;
  return createWalletMcpBinding(sessionId, host);
}

/** A host-owned configuration identity. A JSON copy never acquires this binding. */
export function createWalletMcpBinding(sessionId: string, host: WalletHostPort) {
  const config: McpServerConfig = Object.freeze({
    type: "stdio", command: "__koincode_wallet_host__",
    source: Object.freeze({ kind: "builtin" as const }),
    timeoutMs: WALLET_HOST_TIMEOUT_MS, isolation: "session",
  });
  return { config, wrap: (delegate: McpPort, ownsDelegate = true, store?: ToolArtifactStorePort): McpPort =>
    wrapWalletMcp(delegate, config, sessionId, host, ownsDelegate, store) };
}

function wrapWalletMcp(delegate: McpPort, config: McpServerConfig, sessionId: string, host: WalletHostPort, ownsDelegate: boolean, store?: ToolArtifactStorePort): McpPort {
  let connected = false, closed = false;
  const active = new Set<AbortController>();
  const status = (trusted = true): McpServerStatus => ({
    status: trusted && connected && !closed ? "connected" : trusted ? "disconnected" : "untrusted",
    transport: "stdio", toolCount: trusted && connected && !closed ? walletMcpTools.length : 0,
    updatedAt: new Date().toISOString(),
  });
  const tools = (): McpToolDescriptor[] => connected && !closed ? walletMcpTools.map((tool) => ({
    ...structuredClone(tool), serverName: WALLET_HOST_SERVER, toolName: tool.name,
    // Core registers descriptor.name verbatim, just like the standard MCP adapter.
    name: `mcp__${WALLET_HOST_SERVER}__${tool.name}`,
    timeoutMs: WALLET_HOST_TIMEOUT_MS,
  })) : [];
  const stop = () => {
    connected = false;
    for (const controller of active) controller.abort();
  };
  async function call(request: McpCallToolRequest, options?: McpCallToolOptions) {
    const current = readHostToolInvocationContext(options?.hostInvocation);
    if (!connected || closed || !current || current.facts.sessionId !== sessionId ||
      current.facts.toolName !== `mcp__${WALLET_HOST_SERVER}__${request.toolName}` ||
      options?.signal?.aborted) throw new Error("OPERATION_CONTEXT_REQUIRED");
    if (active.size >= WALLET_HOST_MAX_PENDING) throw new Error("WALLET_CHANNEL_CAPACITY");
    const controller = new AbortController();
    const signal = AbortSignal.any([current.signal, controller.signal, ...(options?.signal ? [options.signal] : [])]);
    active.add(controller);
    const timer = setTimeout(() => controller.abort(), WALLET_HOST_TIMEOUT_MS);
    timer.unref();
    try {
      const input = structuredClone(request.arguments ?? {});
      const invocation = { traceId: current.facts.traceId, spanId: current.facts.spanId,
        sessionId: current.facts.sessionId, turnId: current.facts.turnId,
        toolCallId: current.facts.toolCallId, toolName: current.facts.toolName, runtimeScope: current.facts.runtimeScope };
      const send = async (value: unknown, source?: string, requestSignal = signal) => {
        if (!connected || closed || requestSignal.aborted || signal.aborted ||
          readHostToolInvocationContext(options?.hostInvocation) !== current) throw new Error("OPERATION_CONTEXT_REQUIRED");
        const envelope = walletHostCallSchema.parse({ version: 1, callId: randomUUID(),
          toolName: request.toolName, invocation, input: value, ...(source ? { source } : {}) });
        if (Buffer.byteLength(JSON.stringify(envelope)) > WALLET_HOST_MAX_BYTES) throw new Error("REQUEST_TOO_LARGE");
        // Validate the original context once more after parsing/serializing user values.
        if (!connected || closed || signal.aborted || readHostToolInvocationContext(options?.hostInvocation) !== current)
          throw new Error("OPERATION_CONTEXT_REQUIRED");
        const reply = walletHostReplySchema.parse(await host.call(envelope, signal));
        if (!connected || closed || signal.aborted || readHostToolInvocationContext(options?.hostInvocation) !== current) {
          throw new Error("OPERATION_CONTEXT_REQUIRED");
        }
        if (!reply.ok) throw new Error(reply.code);
        return reply.value;
      };
      if (!walletMcpTools.some(tool => tool.name === request.toolName)) throw new Error("TOOL_NOT_FOUND");
      const value = await send(input);
      const result = request.toolName === "wallet_run_client"
        ? await publishClientArtifacts(value, { store, sessionId, turnId: invocation.turnId,
            toolCallId: invocation.toolCallId, toolName: invocation.toolName, signal,
            assertCurrent() {
              if (!connected || closed || signal.aborted || readHostToolInvocationContext(options?.hostInvocation) !== current)
                throw new Error("OPERATION_CONTEXT_REQUIRED");
            } }) : undefined;
      return { content: [{ type: "text", text: JSON.stringify(result ?? value) }] };
    } finally {
      clearTimeout(timer);
      active.delete(controller);
    }
  }
  return {
    async connectConfiguredServers(servers, options) {
      const trusted = servers[WALLET_HOST_SERVER] === config && config.enabled !== false;
      if (!trusted || closed) stop(); else connected = true;
      const ordinary = Object.fromEntries(Object.entries(servers).filter(([name]) => name !== WALLET_HOST_SERVER));
      const snapshot = await delegate.connectConfiguredServers(ordinary, options);
      return { statuses: { ...snapshot.statuses, ...(servers[WALLET_HOST_SERVER] ? { [WALLET_HOST_SERVER]: status(trusted) } : {}) },
        tools: [...snapshot.tools.filter((tool) => tool.serverName !== WALLET_HOST_SERVER), ...tools()] };
    },
    async connectServer(name, candidate, options) {
      if (name !== WALLET_HOST_SERVER) return delegate.connectServer(name, candidate, options);
      const trusted = candidate === config && candidate.enabled !== false;
      if (!trusted || closed) stop(); else connected = true;
      return status(trusted);
    },
    async disconnectServer(name) {
      if (name !== WALLET_HOST_SERVER) return delegate.disconnectServer(name);
      stop(); return status();
    },
    async pingServer(name, options) {
      return name === WALLET_HOST_SERVER ? connected && !closed : (await delegate.pingServer?.(name, options)) ?? true;
    },
    async status() { return { ...await delegate.status(), [WALLET_HOST_SERVER]: status() }; },
    async listTools() { return [...(await delegate.listTools()).filter((tool) => tool.serverName !== WALLET_HOST_SERVER), ...tools()]; },
    async callTool(request, options) {
      return request.serverName === WALLET_HOST_SERVER ? call(request, options) : delegate.callTool(request, options);
    },
    async close() { closed = true; stop(); if (ownsDelegate) await delegate.close(); },
  };
}
