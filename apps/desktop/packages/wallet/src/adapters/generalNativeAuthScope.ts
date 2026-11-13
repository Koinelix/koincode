import { z } from "zod";
import { WalletError, requireWallet } from "../domain/errors.js";
import { assertGeneralBoundedManualFee, GENERAL_SIGNING_POLICY_DIGEST, GENERAL_SIGNING_POLICY_VERSION } from "../domain/generalSigningPolicy.js";
import { canonical } from "./canonical.js";
import { assertGeneralTransferPreview, type GeneralTransferPreview } from "./generalTransferIntent.js";

const ACTIONS = new Set(["create_wallet", "import_mnemonic", "import_private_key", "reveal_mnemonic", "export_private_key", "backup_wallet", "restore_wallet", "manual_transfer"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/, ADDRESS = /^0x[0-9a-f]{40}$/;
export const GENERAL_AUTH_MAX_REQUEST = 32 * 1024;
export const GENERAL_AUTH_MAX_REPLY = 8192;
export type GeneralAuthRequest = { format: "koincode-general-auth-request"; version: 1; requestId: string; action: string;
  operationDigest: string; accountAddress: string | null; locale: "en-US" | "zh-CN"; manualTransfer?: GeneralTransferPreview };
const unavailable = () => new WalletError("GENERAL_AUTH_UNAVAILABLE", "Native wallet authentication is unavailable.");
const uint = z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine((value) => {
  try { return BigInt(value) < (1n << 256n); } catch { return false; }
});
const positive = uint.refine((value) => value !== "0");
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.string().regex(UUID), hash = z.string().regex(DIGEST), address = z.string().regex(ADDRESS);
const baseFee = { gasLimitAtomic: positive, maxLayerFeeAtomic: uint, policy: z.enum(["standard", "op-stack", "arbitrum"]) };
const transfer = z.strictObject({ transferId: id, ownerId: id, accountId: id, accountAddress: address,
  networkId: z.string().max(32), chainId: z.string().max(20),
  asset: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("native"), decimals: z.literal(18) }),
    z.strictObject({ kind: z.literal("erc20"), address, decimals: integer.max(255) })]),
  recipient: address, amountAtomic: positive, nonce: integer,
  fee: z.discriminatedUnion("type", [z.strictObject({ type: z.literal("legacy"), gasPriceAtomic: positive, ...baseFee }),
    z.strictObject({ type: z.literal("eip1559"), maxFeePerGasAtomic: positive, maxPriorityFeePerGasAtomic: uint, ...baseFee })]),
  maxFeeExposureAtomic: positive, unsignedTransaction: z.string().max(16384).regex(/^0x(?:[0-9a-f]{2})+$/),
  configVersion: integer.min(1), signingPolicyVersion: z.literal(GENERAL_SIGNING_POLICY_VERSION), signingPolicyDigest: z.literal(GENERAL_SIGNING_POLICY_DIGEST),
  expiresAt: integer.min(1), digest: hash });

function validate(request: GeneralAuthRequest): void {
  requireWallet(request && typeof request === "object" && !Array.isArray(request), "INVALID_REQUEST", "Invalid native authentication scope.");
  const manual = request.action === "manual_transfer";
  requireWallet(Object.keys(request).sort().join() === ["format", "version", "requestId", "action", "operationDigest", "accountAddress", "locale",
    ...(manual ? ["manualTransfer"] : [])].sort().join() &&
    request.format === "koincode-general-auth-request" && request.version === 1 && UUID.test(request.requestId) &&
    ACTIONS.has(request.action) && DIGEST.test(request.operationDigest) &&
    (request.accountAddress === null || ADDRESS.test(request.accountAddress)) &&
    (!["reveal_mnemonic", "export_private_key"].includes(request.action) || request.accountAddress !== null) &&
    (request.locale === "en-US" || request.locale === "zh-CN"), "INVALID_REQUEST", "Invalid native authentication scope.");
  if (manual) {
    const checked = transfer.safeParse(request.manualTransfer);
    requireWallet(checked.success && request.accountAddress !== null && request.manualTransfer!.accountAddress === request.accountAddress &&
      request.manualTransfer!.digest === request.operationDigest, "INVALID_REQUEST", "Invalid manual authentication scope.");
    const preview = checked.data;
    assertGeneralTransferPreview(preview, request.operationDigest, preview.expiresAt - 1);
    assertGeneralBoundedManualFee(preview.networkId);
  }
}

export function encodeGeneralAuthRequest(request: GeneralAuthRequest): string {
  validate(request);
  const encoded = canonical(request);
  requireWallet(Buffer.byteLength(encoded) <= GENERAL_AUTH_MAX_REQUEST, "INVALID_REQUEST", "Native authentication scope is too large.");
  return encoded;
}

/** A fresh native fact for this exact scope, never a spending grant or secret-admission proof. */
export function parseGeneralAuthReply(request: GeneralAuthRequest, line: string): boolean {
  validate(request);
  requireWallet(line.endsWith("\n") && Buffer.byteLength(line) <= GENERAL_AUTH_MAX_REPLY, "GENERAL_AUTH_UNAVAILABLE", "Invalid native authentication reply.");
  const raw = line.slice(0, -1);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw unavailable(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  const reply = value as Record<string, unknown>;
  if (Object.keys(reply).sort().join() !== "accountAddress,action,authenticated,code,format,operationDigest,requestId,version" ||
      canonical(reply) !== raw || reply.format !== "koincode-general-auth-result" || reply.version !== 1 ||
      reply.requestId !== request.requestId || reply.action !== request.action || reply.operationDigest !== request.operationDigest ||
      reply.accountAddress !== request.accountAddress || typeof reply.authenticated !== "boolean" ||
      typeof reply.code !== "string" || !["GENERAL_AUTHENTICATED", "GENERAL_AUTH_REJECTED", "GENERAL_OPERATION_CANCELED",
        "GENERAL_AUTH_UNAVAILABLE", "GENERAL_AUTH_TIMEOUT"].includes(reply.code) ||
      reply.authenticated !== (reply.code === "GENERAL_AUTHENTICATED")) throw unavailable();
  return reply.authenticated;
}
