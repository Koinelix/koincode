import { z } from "zod";
import { WalletError, requireWallet } from "../domain/errors.js";
import { generalNetwork } from "../domain/generalNetworks.js";
import { canonical } from "./canonical.js";
import { parseGeneralSigningCheckpoint } from "./generalSigningJournal.js";
import { assertGeneralHistoricalIntent } from "./generalTransferIntentStore.js";
import type { GeneralBackupHistory } from "./generalBackupHistory.js";
import type { GeneralSigningRisk } from "../app/generalSigningTypes.js";

const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/), address = z.string().regex(/^0x[0-9a-f]{40}$/);
const uint = z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine((value) => {
  try { return BigInt(value) < (1n << 256n); } catch { return false; }
});
const positive = uint.refine((value) => value !== "0");
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const policy = z.enum(["standard", "op-stack", "arbitrum"]);
const asset = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("native"), decimals: z.literal(18) }),
  z.strictObject({ kind: z.literal("erc20"), address, decimals: z.number().int().min(0).max(255) })]);
const fee = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("legacy"), gasLimitAtomic: positive, gasPriceAtomic: positive, maxLayerFeeAtomic: uint, policy }),
  z.strictObject({ type: z.literal("eip1559"), gasLimitAtomic: positive, maxFeePerGasAtomic: positive,
    maxPriorityFeePerGasAtomic: uint, maxLayerFeeAtomic: uint, policy }),
]);
const preview = z.strictObject({ transferId: id, ownerId: id, accountId: id, accountAddress: address,
  networkId: z.string().regex(/^eip155:[1-9][0-9]{0,19}$/), chainId: z.string().regex(/^[1-9][0-9]{0,19}$/), asset,
  recipient: address, amountAtomic: positive, nonce: integer, fee, maxFeeExposureAtomic: positive,
  unsignedTransaction: z.string().max(16384).regex(/^0x(?:[0-9a-f]{2})+$/), configVersion: integer.min(1),
  signingPolicyVersion: integer, signingPolicyDigest: hash, expiresAt: integer.min(1), digest: hash });
const history = z.strictObject({ format: z.literal("koincode-general-backup-history"), version: z.literal(1), ownerId: id,
  installationId: id, sourceRevision: integer, sourceCommitment: hash, signing: z.unknown(),
  intents: z.array(z.strictObject({ riskId: id, preview: z.unknown() })).max(1000) });

/** Component inspection only: it authenticates neither a backup nor the latest protected signing head. */
export function inspectGeneralBackupHistory(bytes: Uint8Array):
  { status: "v2_structural_only"; history: GeneralBackupHistory } | { status: "legacy_policy_unverified" } {
  try {
    requireWallet(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= 8 * 1024 * 1024,
      "GENERAL_BACKUP_HISTORY_INVALID", "The backup history is invalid.");
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), raw: unknown = JSON.parse(text);
    requireWallet(canonical(raw) === text, "GENERAL_BACKUP_HISTORY_INVALID", "The backup history is invalid.");
    const parsed = history.safeParse(raw);
    requireWallet(parsed.success, "GENERAL_BACKUP_HISTORY_INVALID", "The backup history is invalid.");
    const value = parsed.data, signing = parseGeneralSigningCheckpoint(Buffer.from(canonical(value.signing)));
    requireWallet(signing.checkpoint.ownerId === value.ownerId && signing.checkpoint.installationId === value.installationId,
      "GENERAL_BACKUP_HISTORY_INVALID", "The backup history identity is invalid.");
    if (signing.policy === "legacy_v1") return { status: "legacy_policy_unverified" };
    const risks = new Map<string, GeneralSigningRisk>();
    for (const stream of signing.checkpoint.streams) for (const event of stream.events) if (event.phase === "SIGNING_POSSIBLE")
      risks.set(event.risk.riskId, event.risk);
    requireWallet(risks.size === value.intents.length, "GENERAL_BACKUP_HISTORY_INVALID", "The backup intents are incomplete.");
    const seen = new Set<string>(), intents: GeneralBackupHistory["intents"] = [];
    for (const item of value.intents) {
      const risk = risks.get(item.riskId), checked = preview.safeParse(item.preview);
      requireWallet(risk && !seen.has(item.riskId) && checked.success && Buffer.byteLength(canonical(item.preview)) <= 16384,
        "GENERAL_BACKUP_HISTORY_INVALID", "The backup intent is invalid.");
      const frozen = checked.data, network = generalNetwork(frozen.networkId);
      requireWallet(frozen.chainId === String(network.chainId) && (frozen.asset.kind !== "native" || BigInt(frozen.fee.gasLimitAtomic) >= 21000n) &&
        (frozen.fee.type !== "eip1559" || BigInt(frozen.fee.maxPriorityFeePerGasAtomic) <= BigInt(frozen.fee.maxFeePerGasAtomic)),
      "GENERAL_BACKUP_HISTORY_INVALID", "The backup intent is invalid.");
      assertGeneralHistoricalIntent(frozen, value.ownerId, risk);
      seen.add(item.riskId); intents.push({ riskId: item.riskId, preview: frozen });
    }
    return { status: "v2_structural_only", history: { format: value.format, version: value.version, ownerId: value.ownerId,
      installationId: value.installationId, sourceRevision: value.sourceRevision, sourceCommitment: value.sourceCommitment,
      signing: signing.checkpoint, intents } };
  } catch {
    throw new WalletError("GENERAL_BACKUP_HISTORY_INVALID", "The backup history cannot be verified.");
  }
}
