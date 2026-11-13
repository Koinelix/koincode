import { z } from "zod";
import { walletControlSnapshotSchema } from "./wallet-control.js";

const id = z.uuid();
const ATOMIC = /^[1-9][0-9]{0,77}$/;
const atomic = z
  .string()
  .regex(ATOMIC)
  .refine((v) => ATOMIC.test(v) && BigInt(v) < 1n << 256n);
const address = z.string().regex(/^0x[0-9a-f]{40}$/i);
export const walletPaymentChoiceSchema = z.enum([
  "deny",
  "once",
  "session",
  "persistent",
  "continue",
]);
export const walletPaymentViewSchema = walletControlSnapshotSchema
  .extend({
    approvalId: id,
    allowPersistent: z.boolean().optional(),
    requestId: id,
    operationId: id,
    origin: z.string().max(8192),
    path: z.string().max(8192),
    method: z.enum(["GET", "POST"]),
    payTo: address,
    amountAtomic: atomic,
    paymentScheme: z.enum(["exact", "upto"]).optional(),
    network: z.enum(["eip155:84532", "eip155:8453"]),
    asset: address,
    maxTimeoutSeconds: z.number().int().positive().max(1020),
    bodyByteLength: z
      .number()
      .int()
      .nonnegative()
      .max(1024 * 1024),
    bodySha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    expiresInMs: z.number().int().nonnegative().max(60000),
    diagnosticCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,79}$/)
      .nullable(),
  })
  .strict();
export const walletPaymentNoticeSchema = z
  .object({
    type: z.literal("payment-request"),
    generation: id,
    connectionId: id,
    view: walletPaymentViewSchema,
  })
  .strict();
export const walletPaymentClosedSchema = z
  .object({
    type: z.literal("payment-closed"),
    generation: id,
    approvalId: id,
  })
  .strict();
export const walletPaymentDecisionSchema = z
  .object({
    type: z.literal("payment-decision"),
    generation: id,
    approvalId: id,
    choice: walletPaymentChoiceSchema,
    authenticated: z.boolean().optional(),
  })
  .strict();
export const walletPaymentWindowCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("payment_presentation") }).strict(),
  z.object({ action: z.literal("payment_status") }).strict(),
  z
    .object({
      action: z.literal("payment_decide"),
      approvalId: id,
      choice: walletPaymentChoiceSchema,
    })
    .strict(),
]);
export type WalletPaymentView = z.infer<typeof walletPaymentViewSchema>;
export type WalletPaymentNotice = z.infer<typeof walletPaymentNoticeSchema>;
export type WalletPaymentChoice = z.infer<typeof walletPaymentChoiceSchema>;
