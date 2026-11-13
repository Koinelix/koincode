import { z } from "zod";
import { remoteIdSchema, remotePathSchema, remoteAuthTypeSchema, remoteSecretMaterialSchema } from "./contracts.js";
import { remoteHostFailureSchema } from "./executionSchema.js";
import { remoteHostControlCommandSchema } from "./controlProtocol.js";
import { remoteHostManagementSchemas } from "./management.js";

export const remoteSecretEnvelopeSchema = z.strictObject({
  formatVersion: z.literal(1), hostId: remoteIdSchema, authType: remoteAuthTypeSchema,
  credentialVersion: z.number().int().nonnegative(), material: remoteSecretMaterialSchema,
});
const managementMethod = z.enum(Object.keys(remoteHostManagementSchemas) as [keyof typeof remoteHostManagementSchemas, ...Array<keyof typeof remoteHostManagementSchemas>]);
export const remoteBrokerRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("initialize"), id: remoteIdSchema, protocolVersion: z.literal(2), root: remotePathSchema }),
  z.strictObject({ kind: z.literal("manage"), id: remoteIdSchema, clientInstanceId: remoteIdSchema,
    windowId: remoteIdSchema.optional(), method: managementMethod, input: z.unknown(), selectedPath: remotePathSchema.optional() }),
  z.strictObject({ kind: z.literal("control"), id: remoteIdSchema, scope: z.strictObject({ windowId: remoteIdSchema, hostId: remoteIdSchema }), command: remoteHostControlCommandSchema }),
  z.strictObject({ kind: z.literal("revoke-host"), id: remoteIdSchema, hostId: remoteIdSchema }),
  z.strictObject({ kind: z.literal("revoke-management-client"), id: remoteIdSchema, clientInstanceId: remoteIdSchema }),
  z.strictObject({ kind: z.literal("dispose"), id: remoteIdSchema }),
]);
export const remoteBrokerReplySchema = z.discriminatedUnion("ok", [
  z.strictObject({ kind: z.literal("reply"), id: remoteIdSchema, ok: z.literal(true), value: z.unknown() }),
  z.strictObject({ kind: z.literal("reply"), id: remoteIdSchema, ok: z.literal(false), error: remoteHostFailureSchema }),
]);
export const remoteBrokerSecretRequestSchema = z.strictObject({ kind: z.literal("secret_request"), id: remoteIdSchema,
  operation: z.enum(["status", "seal", "open"]), payload: z.unknown() });
export type RemoteBrokerRequest = z.infer<typeof remoteBrokerRequestSchema>;
export type RemoteBrokerReply = z.infer<typeof remoteBrokerReplySchema>;
export type RemoteBrokerSecretRequest = z.infer<typeof remoteBrokerSecretRequestSchema>;
