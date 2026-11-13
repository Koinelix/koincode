import { NETWORKS } from "../domain/networks.js";
import { z } from "zod";
import type { GeneralWalletRecord, WalletRecord, WalletState } from "../app/state.js";
import type { WalletDatabase, SqlBatch } from "./database.js";
import { GENERAL_SOURCE_SCHEMA_VERSION } from "./schema.js";
import { requireWallet } from "../domain/errors.js";
import { canonical } from "./canonical.js";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const source = z.strictObject({ protection: z.literal("local_system").optional(), installationId: uuid, enrollmentId: uuid, profileId: uuid, sourceId: uuid,
  sourceCommitment: z.string().regex(/^[0-9a-f]{64}$/) });
const wallet = z.strictObject({ kind: z.literal("general_source"), walletId: uuid, subjectId: uuid,
  address: z.string().regex(/^0x[0-9a-f]{40}$/), network: z.enum(["eip155:84532", "eip155:8453"]),
  asset: z.enum([NETWORKS["eip155:84532"].asset, NETWORKS["eip155:8453"].asset]), source,
  baselineBlock: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), baselineHash: z.string().regex(/^0x[0-9a-f]{64}$/) });
function fail(condition: unknown): asserts condition { requireWallet(condition, "GENERAL_SOURCE_BINDING_CONFLICT", "The protected payment source binding is inconsistent."); }
export function validateGeneralPaymentSources(state: WalletState): void {
  const identities = new Set<string>(), walletIds = new Set<string>();
  for (const entry of state.wallets) {
    fail(!walletIds.has(entry.walletId)); walletIds.add(entry.walletId);
    if (entry.kind !== "general_source") { fail(!("source" in entry)); continue; }
    fail(wallet.safeParse(entry).success);
    fail(entry.asset === NETWORKS[entry.network].asset || entry.asset === NETWORKS["eip155:84532"].asset); // Legacy mainnet registrations used the Sepolia asset.
    // A changed source commitment cannot make the same physical source new.
    const identity = canonical([entry.source.installationId, entry.source.enrollmentId, entry.source.profileId, entry.source.sourceId, entry.network, entry.asset]);
    fail(!identities.has(identity)); identities.add(identity);
    const subject = state.subjects.find((value) => value.subjectId === entry.subjectId);
    fail(subject && subject.ownerId === state.ownerId && subject.address === entry.address && subject.network === entry.network && subject.asset === entry.asset);
  }
}
export function validateGeneralPaymentSourceTransition(previous: WalletState, next: WalletState): void {
  validateGeneralPaymentSources(next);
  for (const old of previous.wallets) {
    const current = next.wallets.find((entry) => entry.walletId === old.walletId);
    fail(current && (old.kind === "general_source" ? canonical(current) === canonical(old) : current.kind !== "general_source"));
  }
  for (const current of next.wallets) if (current.kind === "general_source" && !previous.wallets.some((entry) => entry.walletId === current.walletId)) {
    const policy = next.policies[current.subjectId];
    fail(policy && policy.enabled === false && policy.maxPerPaymentAtomic === "0" && policy.maxRolling24hAtomic === "0" && policy.maxCumulativeAtomic === "0");
    fail(!next.grants.some((grant) => grant.subjectId === current.subjectId));
  }
}
export function readGeneralPaymentSources(database: WalletDatabase, legacy: WalletRecord[], ownerId: string): WalletRecord[] {
  if (database.schemaVersion !== GENERAL_SOURCE_SCHEMA_VERSION) return legacy;
  const combined = [...legacy];
  const rows = database.connection.prepare("SELECT * FROM general_wallet_sources ORDER BY wallet_position").all();
  fail(rows.length <= 256);
  for (const row of rows) {
    let value: unknown;
    try { value = JSON.parse(String(row.document)); } catch { fail(false); }
    const parsed = wallet.safeParse(value); fail(parsed.success);
    const entry: GeneralWalletRecord = parsed.data;
    fail(row.document === canonical(entry) && row.owner_id === ownerId && row.wallet_id === entry.walletId && row.subject_id === entry.subjectId &&
      row.network === entry.network && row.asset === entry.asset && row.address === entry.address && row.installation_id === entry.source.installationId &&
      row.enrollment_id === entry.source.enrollmentId && row.profile_id === entry.source.profileId && row.source_id === entry.source.sourceId && row.source_commitment === entry.source.sourceCommitment);
    const position = Number(row.wallet_position); fail(Number.isSafeInteger(position) && position >= 0 && position <= combined.length);
    combined.splice(position, 0, entry);
  }
  return combined;
}
export function persistGeneralPaymentSources(database: WalletDatabase, sql: SqlBatch, state: WalletState): void {
  const entries = state.wallets.filter((entry) => entry.kind === "general_source");
  fail(entries.length <= 256 && (!entries.length || database.schemaVersion === GENERAL_SOURCE_SCHEMA_VERSION));
  for (const entry of entries) sql.prepare(`INSERT INTO general_wallet_sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(wallet_id) DO NOTHING`)
    .run(entry.walletId, entry.subjectId, state.ownerId, entry.network, entry.asset, entry.address, entry.source.installationId,
      entry.source.enrollmentId, entry.source.profileId, entry.source.sourceId, entry.source.sourceCommitment, state.wallets.indexOf(entry), canonical(entry));
}
