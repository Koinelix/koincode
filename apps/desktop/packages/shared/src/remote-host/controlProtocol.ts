import { z } from "zod";
import { remoteIdSchema, remotePathSchema } from "./contracts.js";
import { REMOTE_HOST_TOOLS, REMOTE_HOST_PLUGIN_ID } from "./limits.js";
import { remoteHostFailureSchema } from "./executionSchema.js";

export const remoteInvocationIdentitySchema = z.strictObject({ sessionId: remoteIdSchema, turnId: remoteIdSchema, toolCallId: remoteIdSchema });
export const remoteHumanPermissionDecisionSchema = z.strictObject({
  source: z.literal("user_prompt"), responseId: remoteIdSchema,
  decision: z.enum(["allow_once", "allow_read_scope", "allow_session", "deny"]), mode: z.enum(["default", "plan"]),
  sessionOfferId: remoteIdSchema.optional(),
  acknowledgedUnknownExecutionIds: z.array(remoteIdSchema).max(200).default([]),
});
const client = { clientInstanceId: z.uuid() };
const call = { ...client, identity: remoteInvocationIdentitySchema };
export const remoteHostControlCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("open-agent"), ...client, workspaceKey: remotePathSchema, workspaceRoot: remotePathSchema,
    agentGeneration: z.uuid() }),
  z.strictObject({ kind: z.literal("set-plugin"), ...client, pluginId: z.literal(REMOTE_HOST_PLUGIN_ID),
    enabled: z.boolean(), protocolVersion: z.literal(2) }),
  z.strictObject({ kind: z.literal("get-plugin-generation"), ...client }),
  z.strictObject({ kind: z.literal("verify-plugin"), ...client, enabled: z.boolean(),
    pluginGeneration: z.string().regex(/^[a-f0-9]{64}$/).optional() }),
  z.strictObject({ kind: z.literal("begin-plugin-mutation"), mutationId: z.uuid(), workspaceKey: remotePathSchema.optional() }),
  z.strictObject({ kind: z.literal("end-plugin-mutation"), mutationId: z.uuid() }),
  z.strictObject({ kind: z.literal("register-submission"), ...client, selectionId: remoteIdSchema, submissionId: remoteIdSchema }),
  z.strictObject({ kind: z.literal("start-turn"), ...client, sessionId: remoteIdSchema, turnId: remoteIdSchema,
    messageId: remoteIdSchema, inputId: remoteIdSchema, traceId: remoteIdSchema, humanUser: z.boolean(), runtimeScope: z.enum(["main", "subagent"]) }),
  z.strictObject({ kind: z.literal("register-call"), ...call, tool: z.enum(REMOTE_HOST_TOOLS), input: z.unknown(), trustedBuiltin: z.boolean() }),
  z.strictObject({ kind: z.literal("rewrite-call"), ...call, tool: z.enum(REMOTE_HOST_TOOLS), input: z.unknown(), trustedBuiltin: z.literal(true) }),
  z.strictObject({ kind: z.literal("start-call"), ...call }),
  z.strictObject({ kind: z.literal("close-call"), ...call }),
  z.strictObject({ kind: z.literal("close-session"), ...client, sessionId: remoteIdSchema }),
  z.strictObject({ kind: z.literal("close-turn"), ...client, sessionId: remoteIdSchema, turnId: remoteIdSchema,
    reason: z.enum(["completed", "stopped", "failed"]) }),
  z.strictObject({ kind: z.literal("read-request"), ...call }),
  z.strictObject({ kind: z.literal("read-decision"), ...call, decision: remoteHumanPermissionDecisionSchema }),
  z.strictObject({ kind: z.literal("prepare"), ...call }),
  z.strictObject({ kind: z.literal("final-decision"), ...call, preparedCallId: remoteIdSchema, decision: remoteHumanPermissionDecisionSchema }),
  z.strictObject({ kind: z.literal("approve-session-operation"), ...call, preparedCallId: remoteIdSchema, mode: z.enum(["default", "plan"]) }),
  z.strictObject({ kind: z.literal("approve-scoped-read"), ...call, preparedCallId: remoteIdSchema }),
  z.strictObject({ kind: z.literal("revoke-agent"), ...client }),
]);
export type RemoteHostControlCommand = z.infer<typeof remoteHostControlCommandSchema>;
export const remoteHostPluginGenerationSchema = z.strictObject({ pluginGeneration: z.string().regex(/^[a-f0-9]{64}$/) });
export type RemoteHostScopedControl = RemoteHostControlCommand extends infer Command
  ? Command extends { kind: "open-agent" } ? never : Command extends { clientInstanceId: string } ? Omit<Command, "clientInstanceId"> : never
  : never;
export const remoteHostControlResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: z.unknown() }),
  z.strictObject({ ok: z.literal(false), error: remoteHostFailureSchema }),
]);
export type RemoteHostControlResult = z.infer<typeof remoteHostControlResultSchema>;
export const remoteHostHostCommandSchema = z.strictObject({ type: z.literal("remote-host-control-request"),
  requestId: z.uuid(), command: remoteHostControlCommandSchema });
export const remoteHostHostResultSchema = z.strictObject({ type: z.literal("remote-host-control-result"),
  requestId: z.uuid(), result: remoteHostControlResultSchema });

export const remoteHostAgentCredentialsSchema = z.strictObject({ socket: remotePathSchema, token: z.string().regex(/^[a-f0-9]{64}$/),
  protocolVersion: z.literal(2), ownerId: remoteIdSchema, clientInstanceId: z.uuid(), workspaceKey: remotePathSchema,
  agentGeneration: z.uuid(), brokerGeneration: z.uuid() });
export interface RemoteHostControlPort { control(command: RemoteHostScopedControl): Promise<unknown> }
export interface RemoteHostAgentPort extends RemoteHostControlPort {
  registerSubmission(selectionId: string, submissionId: string): Promise<void>;
  control(command: RemoteHostScopedControl): Promise<unknown>;
  revoke(): Promise<void>;
}
export interface RemoteHostSubmissionPort {
  getRuntimeEnv(context: { workspaceKey: string; workspacePath: string; workspaceIdentity?: string }): Promise<Record<string, string>>;
  getAgent(workspaceKey: string): RemoteHostAgentPort | undefined;
  revokeWorkspace(workspaceKey: string): Promise<void>;
  revokeSession?(workspaceKey: string, sessionId: string): Promise<void>;
  beginPluginMutation(workspaceKey?: string): Promise<string>;
  endPluginMutation(mutationId: string): Promise<void>;
}
