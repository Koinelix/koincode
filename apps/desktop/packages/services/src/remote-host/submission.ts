import { remoteHostPluginGenerationSchema, RemoteHostError, type RemoteHostAgentPort } from "@fcode/shared";

export async function authorizeRemoteHostSubmission(input: {
  human: boolean; trustedLocal: boolean; agent?: RemoteHostAgentPort; selectionId?: string; commandId: string;
  isCompatiblePluginEnabled(): Promise<boolean>;
}): Promise<void> {
  if (!input.human || !input.trustedLocal || !input.agent) {
    if (input.selectionId) throw new RemoteHostError("permission_denied", "Remote Host requires a trusted local desktop submission.", "authorization");
    return;
  }
  try {
    const generation = remoteHostPluginGenerationSchema.parse(await input.agent.control({ kind: "get-plugin-generation" }));
    const enabled = await input.isCompatiblePluginEnabled();
    await input.agent.control({ kind: "verify-plugin", enabled, ...generation });
    if (!input.selectionId) return;
    if (!enabled) throw new RemoteHostError("plugin_unavailable", "Remote Host is disabled or its built-in component is unavailable. Check the feature settings or update FCode before sending this task.", "authorization");
    await input.agent.registerSubmission(input.selectionId, input.commandId);
  } catch (error) {
    await input.agent.control({ kind: "verify-plugin", enabled: false }).catch(() => {});
    // A closed remote capability must not block an ordinary local message.
    if (input.selectionId) throw error;
  }
}
