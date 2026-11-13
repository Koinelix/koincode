import { createHash } from "node:crypto";
import { z } from "zod";
import { GENERAL_SIGNING_POLICY_DIGEST, GENERAL_SIGNING_POLICY_VERSION, PREVIOUS_GENERAL_SIGNING_POLICY_DIGEST, LEGACY_GENERAL_SIGNING_POLICY_DIGEST } from "../domain/generalSigningPolicy.js";
import { assertGeneralSigningPolicy } from "./generalSigningPolicyVerification.js";
import { WalletError, requireWallet } from "../domain/errors.js";

import { generalDerivationIndex } from "../domain/generalDerivation.js";

const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const keyRef = z.string().regex(/^source-key:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const source = z.strictObject({
  id, setupId: id, address: z.string().regex(/^0x[0-9a-f]{40}$/),
  sourceType: z.enum(["mnemonic", "private_key"]),
  protectedMaterial: z.string().min(1).max(8192), keyRef,
  inputDigest: digest,
  derivationPath: z.string().optional(), backupVerified: z.boolean(),
  status: z.enum(["staged", "ready"]), createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const setup = z.strictObject({
  id, mode: z.enum(["create", "import_mnemonic", "import_private_key"]), createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), inputBinding: digest,
  phase: z.enum(["started", "secret_staged", "backup_pending", "ready", "canceled"]),
  stagedCommitment: digest.optional(), resumePhase: z.enum(["secret_staged", "backup_pending"]).optional(),
  pendingKeyRef: keyRef.optional(),
  backupPositions: z.array(z.number().int().min(0).max(11)).length(3).optional(),
});
const hex = (length: number) => z.string().regex(new RegExp(`^[0-9a-fA-F]{${length}}$`));
const keystoreSchema = z.strictObject({
  address: hex(40), id, version: z.literal(3),
  Crypto: z.strictObject({
    cipher: z.literal("aes-128-ctr"), cipherparams: z.strictObject({ iv: hex(32) }),
    ciphertext: hex(64), kdf: z.literal("scrypt"),
    kdfparams: z.strictObject({ salt: hex(64), n: z.literal(131072), dklen: z.literal(32), p: z.literal(1), r: z.literal(8) }),
    mac: hex(64),
  }),
});
const schema = z.strictObject({
  format: z.literal("koincode-general-wallet-state"), version: z.literal(1),
  ownerId: id, installationId: id, revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  signingPolicyVersion: z.union([z.literal(GENERAL_SIGNING_POLICY_VERSION), z.literal(2)]), signingPolicyDigest: z.enum([GENERAL_SIGNING_POLICY_DIGEST, PREVIOUS_GENERAL_SIGNING_POLICY_DIGEST]),
  setups: z.array(setup).max(1000), sources: z.array(source).max(256),
});
const legacySchema = schema.extend({ signingPolicyVersion: z.literal(1), signingPolicyDigest: z.literal(LEGACY_GENERAL_SIGNING_POLICY_DIGEST) });
export type GeneralWalletState = z.infer<typeof schema>;
export type GeneralLegacyWalletState = z.infer<typeof legacySchema>;
export type GeneralKeySource = z.infer<typeof source>;

/** Only immutable source identity and ciphertext are committed; backup state can advance separately. */
export function generalSourceCommitment(value: GeneralKeySource): string {
  return createHash("sha256").update(JSON.stringify([value.id, value.setupId, value.address, value.sourceType,
    value.protectedMaterial, value.keyRef, value.inputDigest, value.derivationPath ?? null, value.createdAt])).digest("hex");
}

function validateState(value: unknown, legacy: boolean): GeneralWalletState | GeneralLegacyWalletState {
  assertGeneralSigningPolicy();
  const parsed = (legacy ? legacySchema : schema).safeParse(value);
  if (!parsed.success) throw new WalletError("GENERAL_STORE_UNAVAILABLE", "The protected general wallet state is invalid.");
  const state = parsed.data;
  if (!legacy) requireWallet(state.signingPolicyDigest === (state.signingPolicyVersion === 2 ? PREVIOUS_GENERAL_SIGNING_POLICY_DIGEST : GENERAL_SIGNING_POLICY_DIGEST),
    "GENERAL_STORE_UNAVAILABLE", "The stored signing policy identity is inconsistent.");
  const ids = new Set<string>(), addresses = new Set<string>(), refs = new Set<string>(), setupIds = new Set<string>(), pendingRefs = new Set<string>();
  for (const item of state.setups) {
    requireWallet(!setupIds.has(item.id), "GENERAL_STORE_UNAVAILABLE", "The setup identity is duplicated.");
    setupIds.add(item.id);
    if (item.pendingKeyRef) {
      requireWallet(!pendingRefs.has(item.pendingKeyRef), "GENERAL_STORE_UNAVAILABLE", "The setup key reference is duplicated.");
      pendingRefs.add(item.pendingKeyRef);
    }
    requireWallet(item.phase === "started" ? !item.stagedCommitment && !item.resumePhase :
      item.phase === "canceled" ? (item.stagedCommitment ? !!item.resumePhase : !item.resumePhase) :
      !!item.stagedCommitment && !item.resumePhase,
    "GENERAL_STORE_UNAVAILABLE", "The setup phase is inconsistent.");
    requireWallet(!item.backupPositions || (item.mode === "create" && new Set(item.backupPositions).size === 3),
      "GENERAL_STORE_UNAVAILABLE", "The backup challenge is invalid.");
    requireWallet(item.mode !== "create" || (item.phase !== "backup_pending" && item.phase !== "ready") || !!item.backupPositions,
      "GENERAL_STORE_UNAVAILABLE", "The backup challenge is missing.");
  }
  for (const item of state.setups) {
    const matching = state.sources.filter((entry) => entry.setupId === item.id);
    requireWallet(item.stagedCommitment ? matching.length === 1 : matching.length === 0,
      "GENERAL_STORE_UNAVAILABLE", "The setup source is incomplete.");
  }
  for (const item of state.sources) {
    requireWallet(!ids.has(item.id) && !addresses.has(item.address) && !refs.has(item.keyRef),
      "GENERAL_STORE_UNAVAILABLE", "The protected wallet source is duplicated.");
    ids.add(item.id); addresses.add(item.address); refs.add(item.keyRef);
    const operation = state.setups.find((entry) => entry.id === item.setupId);
    requireWallet(operation && operation.stagedCommitment === generalSourceCommitment(item) && operation.pendingKeyRef === item.keyRef &&
      item.keyRef === `source-key:${item.id}` &&
      ((operation.mode === "import_private_key") === (item.sourceType === "private_key")) &&
      ((item.status === "ready") === (operation.phase === "ready")),
    "GENERAL_STORE_UNAVAILABLE", "The source does not match its protected setup.");
    if (item.sourceType === "mnemonic") {
      requireWallet(typeof item.derivationPath === "string", "GENERAL_STORE_UNAVAILABLE", "The mnemonic path is missing.");
      try { generalDerivationIndex(item.derivationPath); } catch { throw new WalletError("GENERAL_STORE_UNAVAILABLE", "The mnemonic path is invalid."); }
      requireWallet(
        /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(item.protectedMaterial),
      "GENERAL_STORE_UNAVAILABLE", "The mnemonic envelope is invalid.");
      try {
        const header = JSON.parse(Buffer.from(item.protectedMaterial.split(".")[0]!, "base64url").toString("utf8")) as Record<string, unknown>;
        requireWallet(header && Object.keys(header).sort().join() === "address,alg,enc,family,keySourceId,ownerId,sourceType,typ,version" &&
          header.alg === "dir" && header.enc === "A256GCM" && header.typ === "koincode-general-secret+jwe" && header.version === 1 &&
          header.ownerId === state.ownerId && header.keySourceId === item.id && header.address === item.address &&
          header.family === "evm" && header.sourceType === "mnemonic", "GENERAL_STORE_UNAVAILABLE", "The mnemonic source binding is invalid.");
      } catch { throw new WalletError("GENERAL_STORE_UNAVAILABLE", "The mnemonic source binding is invalid."); }
    } else {
      requireWallet(item.derivationPath === undefined, "GENERAL_STORE_UNAVAILABLE", "The private key source has an invalid path.");
      try {
        const data = keystoreSchema.safeParse(JSON.parse(item.protectedMaterial));
        requireWallet(data.success && `0x${data.data.address.toLowerCase()}` === item.address,
          "GENERAL_STORE_UNAVAILABLE", "The private key keystore is invalid.");
      } catch { throw new WalletError("GENERAL_STORE_UNAVAILABLE", "The private key keystore is invalid."); }
    }
  }
  const active = state.setups.filter((item) => ["started", "secret_staged", "backup_pending"].includes(item.phase));
  requireWallet(active.length <= 1 && state.setups.filter((item) => item.phase !== "ready" && item.stagedCommitment).length <= 5,
    "GENERAL_STORE_UNAVAILABLE", "The protected setup capacity is invalid.");
  return state;
}

/** The legacy parser never creates a mutable wallet owner or confers signing authority. */
export function validateGeneralLegacyState(value: unknown): GeneralLegacyWalletState {
  return validateState(value, true) as GeneralLegacyWalletState;
}

export function validateGeneralState(value: unknown): GeneralWalletState {
  return validateState(value, false) as GeneralWalletState;
}

export function assertGeneralStateAdvance(previous: GeneralWalletState, next: GeneralWalletState): void {
  requireWallet(previous.signingPolicyVersion === next.signingPolicyVersion && previous.signingPolicyDigest === next.signingPolicyDigest &&
    previous.ownerId === next.ownerId && previous.installationId === next.installationId &&
    next.revision === previous.revision + 1, "GENERAL_STORE_UNAVAILABLE", "The protected state cannot be rebound.");
  for (const old of previous.sources) {
    const current = next.sources.find((item) => item.id === old.id);
    requireWallet(current && generalSourceCommitment(current) === generalSourceCommitment(old) &&
      (!old.backupVerified || current.backupVerified) && (old.status !== "ready" || current.status === "ready"),
    "GENERAL_STORE_UNAVAILABLE", "Existing protected sources cannot be removed or rebound.");
  }
  for (const old of previous.setups) {
    const current = next.setups.find((item) => item.id === old.id);
    const allowed = old.phase === "started" ? ["started", "secret_staged", "canceled"]
      : old.phase === "secret_staged" ? ["secret_staged", "backup_pending", "canceled", ...(old.mode === "create" ? [] : ["ready"])]
      : old.phase === "backup_pending" ? ["backup_pending", "ready", "canceled"]
      : old.phase === "canceled" ? ["canceled", ...(old.resumePhase ? [old.resumePhase] : [])] : ["ready"];
    requireWallet(current && current.mode === old.mode && current.createdAt === old.createdAt && current.inputBinding === old.inputBinding && allowed.includes(current.phase) &&
      (!old.stagedCommitment || current.stagedCommitment === old.stagedCommitment) &&
      (!old.pendingKeyRef || current.pendingKeyRef === old.pendingKeyRef) &&
      (!old.backupPositions || JSON.stringify(current.backupPositions) === JSON.stringify(old.backupPositions)) &&
      (old.phase !== "canceled" || current.phase !== "canceled" || current.resumePhase === old.resumePhase),
    "GENERAL_STORE_UNAVAILABLE", "Existing setup identities cannot be removed or rebound.");
  }
}

/** A newer protected snapshot may repair an older projection only without losing any known source. */
export function assertGeneralStateForward(previous: GeneralWalletState, next: GeneralWalletState): void {
  requireWallet(previous.signingPolicyVersion === next.signingPolicyVersion && previous.signingPolicyDigest === next.signingPolicyDigest &&
    previous.ownerId === next.ownerId && previous.installationId === next.installationId && next.revision > previous.revision,
    "GENERAL_STORE_UNAVAILABLE", "The protected state cannot be rebound.");
  for (const old of previous.sources) {
    const current = next.sources.find((item) => item.id === old.id);
    requireWallet(current && generalSourceCommitment(current) === generalSourceCommitment(old) &&
      (!old.backupVerified || current.backupVerified) && (old.status !== "ready" || current.status === "ready"),
    "GENERAL_STORE_UNAVAILABLE", "A protected source was lost or rebound.");
  }
  for (const old of previous.setups) {
    const current = next.setups.find((item) => item.id === old.id);
    requireWallet(current && current.mode === old.mode && current.createdAt === old.createdAt && current.inputBinding === old.inputBinding &&
      (!old.stagedCommitment || current.stagedCommitment === old.stagedCommitment) &&
      (!old.pendingKeyRef || current.pendingKeyRef === old.pendingKeyRef) &&
      (!old.backupPositions || JSON.stringify(current.backupPositions) === JSON.stringify(old.backupPositions)) &&
      (old.phase !== "ready" || current.phase === "ready"),
    "GENERAL_STORE_UNAVAILABLE", "A protected setup was lost or rebound.");
  }
}
