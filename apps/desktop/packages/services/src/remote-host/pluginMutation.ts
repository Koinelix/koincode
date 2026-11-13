import type { RemoteHostSubmissionPort } from "@fcode/shared";
import { FCodeProtocolClientError } from "../fcode-agent/fcodeProtocolClientErrors.js";

/** Transport failures have no terminal receipt; keep the broker fence until its owning Host exits. */
export async function withRemoteHostPluginMutation<T>(port: RemoteHostSubmissionPort | undefined,
  scope: { workspaceKey?: string } | undefined, run: () => Promise<T>): Promise<T> {
  if (!port || !scope) return run();
  const mutationId = await port.beginPluginMutation(scope.workspaceKey);
  let value: T;
  try { value = await run(); }
  catch (error) {
    if (error instanceof FCodeProtocolClientError) await port.endPluginMutation(mutationId).catch(() => {});
    throw error;
  }
  await port.endPluginMutation(mutationId);
  return value;
}

export function remoteHostPluginMutationScope(input: {
  action: "install" | "uninstall" | "update" | "marketplace" | "enable" | "configure";
  workspaceKey: string; workspaceIdentity?: string; remoteSessionId?: string;
  pluginId?: string; pluginName?: string; marketplace?: string; scope?: "user" | "workspace"; dryRun?: boolean;
}): { workspaceKey?: string } | undefined {
  if (input.workspaceIdentity || input.remoteSessionId || input.dryRun) return undefined;
  const official = "fcode-plugins-official";
  const remote = "remote-host@fcode-plugins-official";
  if (input.action === "enable" || input.action === "configure") {
    if (input.pluginId !== remote) return undefined;
    return input.scope === "workspace" ? { workspaceKey: input.workspaceKey } : {};
  }
  if (input.action === "install") return input.marketplace === official ? {} : undefined;
  if (input.action === "marketplace") return !input.marketplace || input.marketplace === official ? {} : undefined;
  if (input.pluginId) return input.pluginId === remote ? {} : undefined;
  if (input.pluginName) return input.pluginName === "remote-host" && (!input.marketplace || input.marketplace === official) ? {} : undefined;
  return !input.marketplace || input.marketplace === official ? {} : undefined;
}
