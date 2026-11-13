import { uptoTypedData, usdcPermitTypedData, validateUptoAuthorization, type UptoAuthorization } from "../domain/uptoAuthorization.js";
import { z } from "zod";
import { TypedDataEncoder } from "ethers";
import type { ExactAuthorization } from "../domain/model.js";
import type { GeneralManagedKey, PaymentSigningContext } from "../app/ports.js";
import { WalletError } from "../domain/errors.js";
import { canonical, digest } from "./canonical.js";
import { networkConfig } from "../domain/networks.js";
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/), address = z.string().regex(/^0x[0-9a-f]{40}$/);
const atomic = z.string().regex(/^[1-9][0-9]{0,77}$/).refine((value) => BigInt(value) < 1n << 256n);
const uint = z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine(value => BigInt(value) < 1n << 256n);
const timestamp = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const source = z.strictObject({ protection: z.literal("local_system").optional(), installationId: uuid, enrollmentId: uuid, profileId: uuid, sourceId: uuid, sourceCommitment: hash });
const authorization = z.strictObject({ network: z.enum(["eip155:84532", "eip155:8453"]), asset: address,
  payer: address, payTo: address, amountAtomic: atomic, nonce: z.string().regex(/^0x[0-9a-f]{64}$/), validAfter: timestamp, validBefore: timestamp, upto: z.strictObject({ facilitator: address, permitNonce: uint.nullable() }).optional() })
  .refine((value) => value.validBefore > value.validAfter && value.asset === networkConfig(value.network).asset);
const schema = z.strictObject({ format: z.enum(["koincode-general-exact-payment", "koincode-general-upto-payment"]), version: z.literal(1),
  purpose: z.enum(["x402_exact_base_sepolia", "x402_exact_base", "x402_upto", "x402_usdc_permit"]), walletId: uuid, subjectId: uuid, intentId: uuid, requestId: uuid,
  requestDigest: hash, quoteDigest: hash, source, authorization });
export type GeneralExactPayment = Readonly<z.infer<typeof schema>>;
export function validateGeneralExactPayment(input: unknown): GeneralExactPayment {
  try {
    const result = schema.parse(input);
    if (result.authorization.upto) {
      validateUptoAuthorization(result.authorization as UptoAuthorization);
      if (result.format !== "koincode-general-upto-payment" || !["x402_upto", "x402_usdc_permit"].includes(result.purpose) ||
        result.purpose === "x402_usdc_permit" && result.authorization.upto.permitNonce === null) throw new Error();
      Object.freeze(result.authorization.upto);
    } else if (result.format !== "koincode-general-exact-payment" ||
      result.purpose !== (result.authorization.network === "eip155:8453" ? "x402_exact_base" : "x402_exact_base_sepolia")) throw new Error();
    if (Buffer.byteLength(canonical(result)) > 4096) throw new Error();
    Object.freeze(result.source); Object.freeze(result.authorization); return Object.freeze(result);
  } catch { throw new WalletError("PERMIT_MISMATCH", "The protected exact-payment intent is invalid."); }
}
/** Metadata only. The actual fixed peer, original ledger checks and native
 * source inspection are required separately; this digest grants nothing. */
export function createGeneralExactPayment(key: GeneralManagedKey, input: ExactAuthorization, context: Readonly<PaymentSigningContext>, permit = false): GeneralExactPayment {
  if (key.network !== input.network || key.address !== input.payer) throw new WalletError("PERMIT_MISMATCH", "The payment source does not match the authorization.");
  return validateGeneralExactPayment({ format: input.upto ? "koincode-general-upto-payment" : "koincode-general-exact-payment", version: 1, purpose: input.upto ? (permit ? "x402_usdc_permit" : "x402_upto") : input.network === "eip155:8453" ? "x402_exact_base" : "x402_exact_base_sepolia",
    ...context, source: key.source, authorization: input });
}
export function generalExactPaymentDigest(input: GeneralExactPayment): string { return digest(validateGeneralExactPayment(input)); }
export function generalExactPaymentTypedData(input: GeneralExactPayment) {
  const { authorization: value } = validateGeneralExactPayment(input);
  if (value.upto) return input.purpose === "x402_usdc_permit" ? usdcPermitTypedData(value as UptoAuthorization) : uptoTypedData(value as UptoAuthorization);
  const config = networkConfig(value.network);
  return { domain: { name: config.domainName, version: config.domainVersion, chainId: config.chainId, verifyingContract: config.asset },
    types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
    message: { from: value.payer, to: value.payTo, value: value.amountAtomic, validAfter: value.validAfter, validBefore: value.validBefore, nonce: value.nonce } };
}
export function generalExactPaymentSigningHash(input: GeneralExactPayment): string {
  const data = generalExactPaymentTypedData(input); return TypedDataEncoder.hash(data.domain, data.types, data.message);
}
