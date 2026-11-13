import { z } from "zod";

export const WALLET_HOST_SERVER = "koincode_wallet";
export const WALLET_HOST_PLUGIN_ID = "koin-wallet@fcode-plugins-official";
export const WALLET_HOST_TIMEOUT_MS = 50 * 60 * 1000;
export const WALLET_HOST_MAX_BYTES = 2 * 1024 * 1024;
export const WALLET_HOST_MAX_PENDING = 32;
// One bounded control slot keeps read-only admission status available when payment calls fill the channel.
export function walletHostHasCapacity(entries: Iterable<{ statusProbe: boolean }>, statusProbe: boolean): boolean {
  let count = 0;
  for (const entry of entries) if (entry.statusProbe === statusProbe) count++;
  return count < (statusProbe ? 1 : WALLET_HOST_MAX_PENDING);
}
export const WALLET_HOST_IMAGE_CHUNK_BYTES = 256 * 1024;
export const WALLET_HOST_IMAGE_MAX_BYTES = 32 * 1024 * 1024;
export const WALLET_HOST_IMAGE_READ_TIMEOUT_MS = 30_000;
export const WALLET_HOST_IMAGE_RELEASE_TIMEOUT_MS = 5_000;
const WALLET_CLIENT_LIMIT_ATOMIC = /^(0|[1-9][0-9]{0,77})$/;
export const walletClientPaymentLimitSchema = z.object({
  network: z.string().max(100).regex(/^eip155:[1-9][0-9]*$/),
  asset: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  maxAmountAtomic: z.string().regex(WALLET_CLIENT_LIMIT_ATOMIC)
    .refine(value => WALLET_CLIENT_LIMIT_ATOMIC.test(value) && BigInt(value) < (1n << 256n)),
}).strict();
export type WalletClientPaymentLimit = z.infer<typeof walletClientPaymentLimitSchema>;
export const walletHostToolSchema = z.enum([
  "wallet_get_capabilities",
  "wallet_get_info",
  "wallet_run_client",
  "x402_request",
  "x402_get_request",
  "x402_lookup_operation",
  "x402_reconcile",
  "x402_cancel_request",
  "x402_recover_response",
  "x402_export_response",
]);
const id = z.string().min(1).max(256);
export const walletHostInvocationSchema = z
  .object({
    traceId: id,
    spanId: id,
    sessionId: id,
    turnId: id,
    toolCallId: id,
    toolName: id,
    runtimeScope: z.enum(["main", "subagent"]),
  })
  .strict();
export type WalletHostInvocation = z.infer<typeof walletHostInvocationSchema>;
export const walletHostCallSchema = z
  .object({
    version: z.literal(1),
    callId: z.uuid(),
    toolName: walletHostToolSchema,
    invocation: walletHostInvocationSchema,
    source: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    input: z.record(z.string(), z.unknown()),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.toolName === "x402_request") !== (value.source !== undefined))
      ctx.addIssue({
        code: "custom",
        message: "Only a request requires a stable host action source.",
      });
    if (value.invocation.toolName !== `mcp__${WALLET_HOST_SERVER}__${value.toolName}`)
      ctx.addIssue({
        code: "custom",
        message: "The actual invocation must match the canonical wallet tool.",
      });
  });
/** Private model transport. No tool identity or model-controlled authorization is accepted. */
export const walletHostModelCallSchema = z.object({
  version: z.literal(1),
  callId: z.uuid(),
  operationId: z.uuid(),
  invocation: z.object({ traceId: id, spanId: id, sessionId: id, turnId: id,
    modelRequestId: id, runtimeScope: z.enum(["main", "subagent"]) }).strict(),
  method: z.enum(["acquire_payment", "payment_wait_status", "release_payment", "prepare_payment", "authorize_payment", "get_payment", "reconcile_payment", "complete_payment"]),
  input: z.record(z.string(), z.unknown()),
}).strict().refine(call => call.method !== "payment_wait_status" || Object.keys(call.input).length === 0);
export type WalletHostModelCall = z.infer<typeof walletHostModelCallSchema>;
export const walletHostCancelSchema = z
  .object({ version: z.literal(1), callId: z.uuid() })
  .strict();
export const walletHostReplySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), code: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/) }).strict(),
]);
export type WalletHostCall = z.infer<typeof walletHostCallSchema>;
export type WalletHostReply = z.infer<typeof walletHostReplySchema>;
const imageCapability = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);
const imageTransferBase = {
  version: z.literal(1),
  callId: z.uuid(),
  parentCallId: z.uuid(),
  invocation: walletHostInvocationSchema,
  capability: imageCapability,
};
export const walletHostImageReadSchema = z.object({ ...imageTransferBase,
  offset: z.number().int().nonnegative().max(WALLET_HOST_IMAGE_MAX_BYTES),
  limit: z.number().int().positive().max(WALLET_HOST_IMAGE_CHUNK_BYTES),
}).strict().refine((value) => value.callId !== value.parentCallId &&
  [`mcp__${WALLET_HOST_SERVER}__x402_request`, `mcp__${WALLET_HOST_SERVER}__x402_recover_response`].includes(value.invocation.toolName));
export const walletHostImageReleaseSchema = z.object(imageTransferBase).strict()
  .refine((value) => value.callId !== value.parentCallId &&
    [`mcp__${WALLET_HOST_SERVER}__x402_request`, `mcp__${WALLET_HOST_SERVER}__x402_recover_response`].includes(value.invocation.toolName));
export const walletHostImageChunkSchema = z.object({
  offset: z.number().int().nonnegative().max(WALLET_HOST_IMAGE_MAX_BYTES),
  dataBase64: z.string().min(4).max(Math.ceil(WALLET_HOST_IMAGE_CHUNK_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict();
export const walletHostImageEnvelopeSchema = z.object({
  kind: z.literal("host-image"),
  result: z.object({ requestId: id, operationId: id, transportStatus: z.literal("completed"),
    paymentStatus: id, httpStatus: z.number().int().min(200).max(299),
    paymentIntentId: id.optional(), amountAtomic: z.string().regex(/^(0|[1-9][0-9]{0,77})$/).optional(),
    network: id.optional(), transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
    reconciliationPending: z.boolean().optional(),
  }).strict(),
  image: z.object({ capability: imageCapability,
    bytes: z.number().int().positive().max(WALLET_HOST_IMAGE_MAX_BYTES),
    mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    width: z.number().int().positive().max(40_000_000),
    height: z.number().int().positive().max(40_000_000),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict().refine((image) => image.width * image.height <= 40_000_000),
}).strict();
export type WalletHostImageRead = z.infer<typeof walletHostImageReadSchema>;
export type WalletHostImageRelease = z.infer<typeof walletHostImageReleaseSchema>;
export const walletHostAgentSchema = z
  .object({
    workspaceKey: z.string().min(1).max(8192),
    identity: z.string().min(1).max(16384),
    generation: z.number().int().positive(),
  })
  .strict();
export type WalletHostAgent = z.infer<typeof walletHostAgentSchema>;
export const walletHostMainCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("model-call"), input: walletHostModelCallSchema, agent: walletHostAgentSchema }).strict(),
  z
    .object({ kind: z.literal("call"), input: walletHostCallSchema, agent: walletHostAgentSchema })
    .strict(),
  z.object({ kind: z.literal("cancel"), callId: z.uuid() }).strict(),
  z.object({ kind: z.literal("agent-ready"), agent: walletHostAgentSchema }).strict(),
  z.object({ kind: z.literal("agent-closed"), agent: walletHostAgentSchema }).strict(),
  z.object({ kind: z.literal("image-read"), input: walletHostImageReadSchema, agent: walletHostAgentSchema }).strict(),
  z.object({ kind: z.literal("image-release"), input: walletHostImageReleaseSchema, agent: walletHostAgentSchema }).strict(),
]);
export const walletHostMainResultSchema = z.union([
  walletHostReplySchema,
  z.object({ stopped: z.boolean() }).strict(),
]);
export const walletHostHostRequestSchema = z
  .object({
    type: z.literal("wallet-host-request"),
    requestId: z.uuid(),
    command: walletHostMainCommandSchema,
  })
  .strict();
export const walletHostHostResultSchema = z
  .object({
    type: z.literal("wallet-host-result"),
    requestId: z.uuid(),
    result: walletHostMainResultSchema,
  })
  .strict();
export type WalletHostMainCommand = z.infer<typeof walletHostMainCommandSchema>;
export type WalletHostMainResult = z.infer<typeof walletHostMainResultSchema>;
/** Host injection only. Serialized invocation fields do not grant payment or task authority. */
export interface WalletHostPort {
  modelCall?(input: WalletHostModelCall, signal: AbortSignal, agent?: WalletHostAgent): Promise<WalletHostReply>;
  call(
    input: WalletHostCall,
    signal: AbortSignal,
    agent?: WalletHostAgent,
  ): Promise<WalletHostReply>;
  readImage?(input: WalletHostImageRead, signal: AbortSignal, agent?: WalletHostAgent): Promise<WalletHostReply>;
  releaseImage?(input: WalletHostImageRelease, signal: AbortSignal, agent?: WalletHostAgent): Promise<WalletHostReply>;
  /** Trusted Host lifecycle only; never an Agent or renderer command. */
  registerAgent?(agent: WalletHostAgent): void;
  releaseAgent?(agent: WalletHostAgent): void;
}
