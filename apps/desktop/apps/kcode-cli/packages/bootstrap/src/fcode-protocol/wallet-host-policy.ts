import { fcodeWorkspaceUpdateWalletHostPolicyParamsSchema, type FCodeWorkspaceRef } from "@fcode/shared";
import { parseParams, type FCodeProtocolAgentServerContext } from "./server-types.js";

type Context = Pick<FCodeProtocolAgentServerContext, "appRuntimePreferences">;

export function updateWalletHostPolicy(context: Context, raw: unknown) {
  const params = parseParams(fcodeWorkspaceUpdateWalletHostPolicyParamsSchema, raw);
  const enabled = params.enabled && !params.workspace.workspaceIdentity;
  context.appRuntimePreferences.walletHostEnabled = enabled;
  return { workspace: params.workspace, enabled };
}

export function walletHostAvailable(context: Context, workspace: FCodeWorkspaceRef, legacy?: boolean): boolean {
  // Journal reads can materialize a session before its subscribe request arrives.
  // Use the Host's process-owned capability for every activation path.
  return !workspace.workspaceIdentity && (context.appRuntimePreferences.walletHostEnabled ?? legacy === true);
}
