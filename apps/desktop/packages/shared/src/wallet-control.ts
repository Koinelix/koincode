import { z } from "zod";

const UINT256_MAX = (1n << 256n) - 1n;
const ATOMIC = /^(0|[1-9][0-9]{0,77})$/;
const atomic = z
  .string()
  .regex(ATOMIC)
  .refine((value) => ATOMIC.test(value) && BigInt(value) <= UINT256_MAX);
const uuid = z.uuid();
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const address = z.string().regex(/^0x[0-9a-f]{40}$/i);
const time = integer.nullable();
export const walletLimitsInputSchema = z
  .object({
    enabled: z.boolean(),
    maxPerPaymentAtomic: atomic,
    maxRolling24hAtomic: atomic,
    maxCumulativeAtomic: atomic,
  })
  .strict();
export const walletInspectionSectionSchema = z.enum(["clients", "grants", "payments"]);
export const walletControlReadSchema = z
  .object({
    action: z.literal("inspect_wallet"),
    walletId: uuid,
    section: walletInspectionSectionSchema,
    displayOnly: z.literal(true).optional(),
    offset: integer,
  })
  .strict();
export const walletControlMutationSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("use_client"), walletId: uuid, clientId: uuid, offset: integer }).strict(),
  z
    .object({ action: z.literal("set_limits"), walletId: uuid, limits: walletLimitsInputSchema })
    .strict(),
  z
    .object({
      action: z.literal("register_client"),
      walletId: uuid,
      kind: z.enum(["internal", "external"]),
    })
    .strict(),
  z
    .object({ action: z.literal("revoke_client"), walletId: uuid, clientId: uuid, offset: integer })
    .strict(),
  z
    .object({ action: z.literal("revoke_grant"), walletId: uuid, grantId: uuid, offset: integer })
    .strict(),
]);
const wallet = z
  .object({
    walletId: uuid,
    subjectId: uuid,
    address,
    network: z.enum(["eip155:84532", "eip155:8453"]),
    asset: address,
    isDefault: z.boolean(),
    locked: z.boolean(),
    recoveryRequired: z.boolean(),
    signingPaused: z.boolean(),
  })
  .strict();
const common = z.object({
  wallet,
  limits: walletLimitsInputSchema.extend({ version: integer }).strict(),
  budget: z
    .object({
      reservedAtomic: atomic,
      rolling24hSpentAtomic: atomic,
      cumulativeSpentAtomic: atomic,
      rolling24hRemainingAtomic: atomic,
      cumulativeRemainingAtomic: atomic,
      blocked: z.boolean(),
    })
    .strict()
    .nullable(),
  offset: integer,
  nextOffset: integer.nullable(),
});
export const walletControlSnapshotSchema = common.omit({ offset: true, nextOffset: true }).strict();
const client = z
  .object({
    clientId: uuid,
    generation: integer,
    active: z.boolean(),
    kind: z.enum(["internal", "external"]),
    credentialReferences: z.array(z.object({ ref: uuid, origin: z.string().max(8192), path: z.string().max(8192),
      headerName: z.enum(["authorization", "x-api-key"]) }).strict()).optional(),
  })
  .strict();
const grant = z
  .object({
    grantId: uuid,
    clientIds: z.array(uuid).max(128),
    scope: z.enum(["once", "session", "persistent"]),
    origin: z.string().max(8192),
    path: z.string().max(8192),
    pathPrefix: z.boolean(),
    method: z.string().max(32),
    payTo: address,
    maxAmountAtomic: atomic,
    expiresAt: time,
    status: z.enum(["active", "revoked", "paused", "consumed"]),
  })
  .strict();
const payment = z
  .object({
    scheme: z.enum(["exact", "upto"]).optional(),
    network: z.string().min(1).max(128).optional(),
    asset: address.optional(),
    waiverContradicted: z.literal(true).optional(),
    actualAmountAtomic: atomic.optional(),
    intentId: uuid,
    requestId: uuid,
    clientId: uuid,
    origin: z.string().max(8192),
    path: z.string().max(8192),
    method: z.string().max(32),
    payTo: address,
    amountAtomic: atomic,
    status: z.enum([
      "RESERVED",
      "SIGNING",
      "SIGNED",
      "SUBMITTED",
      "UNKNOWN",
      "OBSERVED",
      "CONFIRMED",
      "FAILED_UNSIGNED",
      "EXPIRED_UNSETTLED",
      "CANCELED_UNSETTLED",
    ]),
    reserved: z.boolean(),
    spent: z.boolean(),
    settledAt: time,
    settlementTx: z.string().max(100).optional(),
    settlementBlock: integer.optional(),
    settlementHash: z.string().max(100).optional(),
  })
  .strict();
export const walletInspectionSchema = z.discriminatedUnion("section", [
  common.extend({ desktopClient: client.optional(), section: z.literal("clients"), records: z.array(client).max(50) }).strict(),
  common.extend({ desktopClient: client.optional(), section: z.literal("grants"), records: z.array(grant).max(50) }).strict(),
  common.extend({ desktopClient: client.optional(), section: z.literal("payments"), records: z.array(payment).max(50) }).strict(),
]);
export type WalletControlRead = z.infer<typeof walletControlReadSchema>;
export type WalletControlMutation = z.infer<typeof walletControlMutationSchema>;
export type WalletInspection = z.infer<typeof walletInspectionSchema>;
