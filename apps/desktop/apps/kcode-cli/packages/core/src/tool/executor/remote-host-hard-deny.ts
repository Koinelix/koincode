import type { CollaborationMode } from "@fcode/contracts";
import type { ToolEntry } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";
import { loadProjectPermissionRuleset } from "./permission-rules-persistence.js";
import { resolveRuntimePermissionCapability, resolveRuntimePermissionContext } from "./permission-capability.js";
import { remoteHostRuleNames } from "../remote-host-rule-names.js";

/** Existing deny rules still constrain the dedicated confirmation path; allows can never replace it. */
export async function remoteHostHardDenyReason(deps: ToolExecutorDeps, entry: ToolEntry, toolName: string, input: unknown,
  mode: CollaborationMode): Promise<string | undefined> {
  const context = resolveRuntimePermissionContext(deps);
  const capability = resolveRuntimePermissionCapability(entry, input, context);
  const projectRules = await loadProjectPermissionRuleset(deps);
  for (const ruleName of remoteHostRuleNames(toolName, entry)) {
    const decision = deps.permissionService.checkPermission({ toolName: ruleName, input, enforceSessionDeny: true, mode, riskLevel: entry.metadata.riskLevel,
      workingDirectory: deps.getWorkingDirectory(), planEnabled: deps.sessionModePort?.isPlanEnabled?.(), prePlanMode: deps.sessionModePort?.getPrePlanMode() },
      { ...capability, permission: { ...entry.permission, ...capability.permission, alwaysAsk: true } }, projectRules,
      entry.resolvePermissionRulePolicy?.(input, context));
    if (decision.decision === "deny") return decision.reason ?? "This remote tool is explicitly denied by the current permission policy.";
  }
  return undefined;
}
