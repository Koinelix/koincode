import { z } from "zod";
import { validateGeneralState, type GeneralWalletState } from "../app/generalState.js";
import { GENERAL_SIGNING_POLICY_DIGEST, GENERAL_SIGNING_POLICY_VERSION } from "../domain/generalSigningPolicy.js";
import { generalNetwork } from "../domain/generalNetworks.js";
import { WalletError, requireWallet } from "../domain/errors.js";
import { canonical, digest } from "./canonical.js";
import { inspectGeneralBackupHistory } from "./generalBackupHistoryValidation.js";
import type { GeneralBackupHistory } from "./generalBackupHistory.js";

export const GENERAL_BACKUP_TYPE = "koincode-general-wallet-backup+jwe";
export const GENERAL_BACKUP_MAX_BYTES = 16 * 1024 * 1024;
export const GENERAL_BACKUP_MAX_PAYLOAD = 12 * 1024 * 1024;
const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/), address = z.string().regex(/^0x[0-9a-f]{40}$/);
const keyRef = z.string().regex(/^source-key:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const network = z.string().max(32);
const stream = z.strictObject({ id: hash, accountAddress: address, networkId: network, sequence: integer, headDigest: hash });
const schema = z.strictObject({ format: z.literal("koincode-general-wallet"), version: z.literal(1), backupId: id,
  createdAt: integer.nullable(), ownerId: id, installationId: id,
  generalSigningPolicyVersion: z.literal(GENERAL_SIGNING_POLICY_VERSION), policyDigest: z.literal(GENERAL_SIGNING_POLICY_DIGEST),
  sourceRevision: integer, sourceCommitment: hash, sourceState: z.unknown(),
  keyCoverage: z.strictObject({ sourceIds: z.array(id).max(256), pendingSetupIds: z.array(id).max(1000) }),
  historyCoverage: z.strictObject({ kind: z.literal("whole_domain"), accountAddresses: z.array(address).max(3840), networkIds: z.array(network).max(14) }),
  signingCoverage: z.array(stream).max(3584), wrappingKeys: z.array(z.strictObject({ keyRef, key: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })).min(1).max(1256),
  history: z.unknown() });
export type GeneralBackupPayload = Omit<z.infer<typeof schema>, "sourceState" | "history"> & {
  sourceState: GeneralWalletState; history: GeneralBackupHistory;
};
const archiveSchema = z.strictObject({ sourceState: z.unknown(), history: z.unknown(), keyCoverage: schema.shape.keyCoverage,
  historyCoverage: schema.shape.historyCoverage, signingCoverage: schema.shape.signingCoverage,
  keyRefs: z.array(keyRef).min(1).max(1256) });
export type GeneralBackupArchive = Omit<z.infer<typeof archiveSchema>, "sourceState" | "history"> & {
  sourceState: GeneralWalletState; history: GeneralBackupHistory;
};

export function invalidGeneralBackup(): never { throw new WalletError("GENERAL_BACKUP_INVALID", "The general wallet backup could not be verified."); }
const check = (value: unknown): void => requireWallet(value, "GENERAL_BACKUP_INVALID", "The general wallet backup could not be verified.");
const sortedUnique = (values: readonly string[]): boolean => new Set(values).size === values.length && values.every((value, index) => index === 0 || values[index - 1]! < value);

/** Select only references already owned by this state. This does not read or authorize any source key. */
export function generalBackupSelection(state: GeneralWalletState, value: unknown): { coverage: GeneralBackupPayload["keyCoverage"]; keyRefs: string[] } {
  try {
    const coverage = schema.shape.keyCoverage.parse(value), { sourceIds, pendingSetupIds } = coverage;
    check(sortedUnique(sourceIds) && sortedUnique(pendingSetupIds));
    const wanted = new Set<string>();
    for (const selected of sourceIds) {
      const source = state.sources.find((entry) => entry.id === selected); check(source);
      wanted.add(source!.keyRef);
    }
    for (const selected of pendingSetupIds) {
      const setup = state.setups.find((entry) => entry.id === selected);
      check(setup?.pendingKeyRef && !state.sources.some((entry) => entry.setupId === selected));
      wanted.add(setup!.pendingKeyRef!);
    }
    check(wanted.size > 0);
    return { coverage, keyRefs: [...wanted].sort() };
  } catch { return invalidGeneralBackup(); }
}

/** Exact history projection of an already validated payload. No key values are included or authorized. */
export function generalBackupArchiveSnapshot(payload: GeneralBackupPayload): GeneralBackupArchive {
  return { sourceState: payload.sourceState, history: payload.history, keyCoverage: payload.keyCoverage,
    historyCoverage: payload.historyCoverage, signingCoverage: payload.signingCoverage,
    keyRefs: payload.wrappingKeys.map((entry) => entry.keyRef) };
}

/** Shared structural coverage checks; an archive is not a portable backup or evidence of current continuity. */
export function validateGeneralBackupArchive(value: unknown): GeneralBackupArchive {
  try {
    check(Buffer.byteLength(canonical(value)) <= GENERAL_BACKUP_MAX_PAYLOAD);
    const parsed = archiveSchema.safeParse(value); check(parsed.success);
    if (!parsed.success) return invalidGeneralBackup();
    const row = parsed.data;
    check(Buffer.byteLength(canonical(row.sourceState)) <= 512 * 1024);
    const state = validateGeneralState(row.sourceState);
    const inspected = inspectGeneralBackupHistory(Buffer.from(canonical(row.history)));
    check(inspected.status === "v2_structural_only");
    if (inspected.status !== "v2_structural_only") return invalidGeneralBackup();
    const history = inspected.history;
    check(history.ownerId === state.ownerId && history.installationId === state.installationId &&
      history.sourceRevision === state.revision && history.sourceCommitment === digest(state));
    const wanted = new Set(generalBackupSelection(state, row.keyCoverage).keyRefs);
    check(wanted.size === row.keyRefs.length && sortedUnique(row.keyRefs) && row.keyRefs.every((ref) => wanted.has(ref)));
    const streams = history.signing.streams;
    for (const entry of streams) generalNetwork(entry.networkId);
    const addresses = [...new Set([...state.sources.map((entry) => entry.address), ...streams.map((entry) => entry.accountAddress)])].sort();
    const networks = [...new Set(streams.map((entry) => entry.networkId))].sort();
    const heads = streams.map(({ events: _events, ...metadata }) => metadata).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    check(canonical(row.historyCoverage.accountAddresses) === canonical(addresses) && canonical(row.historyCoverage.networkIds) === canonical(networks) &&
      canonical(row.signingCoverage) === canonical(heads));
    return { ...row, sourceState: state, history };
  } catch { return invalidGeneralBackup(); }
}

/** Structural inspection only. No authentication, material verification, freshness or restore authority is conferred. */
export function validateGeneralBackupPayload(value: unknown): GeneralBackupPayload {
  try {
    check(Buffer.byteLength(canonical(value)) <= GENERAL_BACKUP_MAX_PAYLOAD);
    const row = schema.parse(value);
    const archive = validateGeneralBackupArchive({ sourceState: row.sourceState, history: row.history,
      keyCoverage: row.keyCoverage, historyCoverage: row.historyCoverage, signingCoverage: row.signingCoverage,
      keyRefs: row.wrappingKeys.map((entry) => entry.keyRef) });
    check(row.ownerId === archive.sourceState.ownerId && row.installationId === archive.sourceState.installationId &&
      row.sourceRevision === archive.sourceState.revision && row.sourceCommitment === digest(archive.sourceState));
    for (const entry of row.wrappingKeys) {
      const bytes = Buffer.from(entry.key, "base64url");
      try { check(bytes.byteLength === 32 && bytes.toString("base64url") === entry.key); }
      finally { bytes.fill(0); }
    }
    return { ...row, sourceState: archive.sourceState, history: archive.history };
  } catch { return invalidGeneralBackup(); }
}

/** Only call after authenticated JWE decryption in the protected worker. This returns secret key material. */
export function parseGeneralBackupPayload(bytes: Uint8Array): GeneralBackupPayload {
  try {
    check(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= GENERAL_BACKUP_MAX_PAYLOAD);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), value: unknown = JSON.parse(text);
    check(canonical(value) === text);
    return validateGeneralBackupPayload(value);
  } catch { return invalidGeneralBackup(); }
}
