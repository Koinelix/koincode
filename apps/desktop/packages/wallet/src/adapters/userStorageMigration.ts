import { performance } from "node:perf_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { ProtectedStore } from "../app/ports.js";
import { requireWallet } from "../domain/errors.js";
import { canonical } from "./canonical.js";
import { physicalUserAccount, parseUserActivation, userStorageNamespaces, userStorageRoot, userStorageTransition,
  type UserStorageActivation, type UserStorageNamespace, type UserStorageRegistry } from "./userKeychain.js";

type Entry = { namespace: UserStorageNamespace; account: string; digest: string; size: number; fence: boolean };
export type UserStorageMigrationPlan = { version: 2; generation: string; snapshotDigest: string; entries: Entry[]; payment: "m4-testnet" | "mainnet"; base: UserStorageActivation | null };
export type FrozenUserStorage = {
  legacy: Record<UserStorageNamespace, ProtectedStore>;
  /** Reads original DBs/checkpoints under all original writer leases; never repairs. */
  inspect(stores: Record<UserStorageNamespace, ProtectedStore>): Promise<{ digest: string; fences: Array<{ namespace: UserStorageNamespace; account: string }> }>;
  prepareActivation?(): void;
  close(): void | Promise<void>;
};
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown) => Buffer.from(canonical(value));
function fail(condition: unknown): asserts condition { requireWallet(condition,
  "WALLET_STORAGE_MIGRATION_CONFLICT", "The original wallet storage no longer matches its migration plan."); }
function backup(plan: UserStorageMigrationPlan, account: string): string { return `migration-backup:${plan.generation}:${hash(Buffer.from(account))}`; }
function fence(plan: UserStorageMigrationPlan): Buffer { return encode({ format: "koincode-storage-migrated", version: 2, generation: plan.generation }); }
function parsePlan(bytes: Uint8Array): UserStorageMigrationPlan {
  fail(bytes.byteLength <= 1048576);
  const p = JSON.parse(Buffer.from(bytes).toString("utf8")) as UserStorageMigrationPlan;
  fail(p && Object.keys(p).sort().join() === "base,entries,generation,payment,snapshotDigest,version" && p.version === 2 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(p.generation) && /^[0-9a-f]{64}$/.test(p.snapshotDigest) && Array.isArray(p.entries) && p.entries.length <= 4096);
  fail(p.payment === "m4-testnet" || p.payment === "mainnet");
  if (p.base !== null) { parseUserActivation(encode(p.base)); fail(!p.base.generations[p.payment]); }
  const domains = p.base?.generations.general ? [p.payment] : [p.payment, "general"];
  const keys = new Set<string>(); let total = 0;
  for (const e of p.entries) {
    fail(e && Object.keys(e).sort().join() === "account,digest,fence,namespace,size" && domains.includes(e.namespace) &&
      /^[A-Za-z0-9:._-]{1,200}$/.test(e.account) && /^[0-9a-f]{64}$/.test(e.digest) &&
      Number.isSafeInteger(e.size) && e.size > 0 && e.size <= 1048576 && typeof e.fence === "boolean");
    const key = `${e.namespace}:${e.account}`; fail(!keys.has(key)); keys.add(key); total += e.size;
  }
  fail(total <= 32 * 1048576 && canonical(p) === Buffer.from(bytes).toString("utf8"));
  return p;
}
/** Unknown write results are resolved by exact readback, never blindly replayed. */
async function writeVerified(store: ProtectedStore, account: string, bytes: Uint8Array, check: () => void): Promise<void> {
  check();
  const before = await store.get(account);
  try { check(); if (before !== null) { fail(hash(before) === hash(bytes)); return; } }
  finally { before?.fill(0); }
  let failure: unknown;
  try { check(); await store.put(account, bytes); } catch (error) { failure = error; }
  const after = await store.get(account);
  try { if (after && hash(after) === hash(bytes)) return; if (failure) throw failure; fail(false); }
  finally { after?.fill(0); }
}
/** Private coordinator: caller holds the common activation lease before freezing wallets. */
export class UserStorageMigration {
  constructor(private readonly registry: UserStorageRegistry,
    private readonly freeze: (domains: UserStorageNamespace[]) => Promise<FrozenUserStorage>,
    private readonly payment: "m4-testnet" | "mainnet" = "m4-testnet",
    private readonly progress: () => void = () => {},
    private readonly assertCurrent: () => void = () => {}) {}
  private domains(base: UserStorageActivation | null): UserStorageNamespace[] { return base?.generations.general ? [this.payment] : [this.payment, "general"]; }
  private journal(): string { return `${userStorageTransition}:${this.payment}`; }
  private original(plan: UserStorageMigrationPlan, frozen: FrozenUserStorage): Record<UserStorageNamespace, ProtectedStore> {
    return Object.fromEntries(userStorageNamespaces.map(namespace => [namespace, {
      get: async (account: string) => {
        const raw = await frozen.legacy[namespace].get(account);
        if (raw && hash(raw) === hash(fence(plan))) {
          raw.fill(0);
          const entry = plan.entries.find(e => e.namespace === namespace && e.account === account && e.fence);
          fail(entry); const saved = await frozen.legacy[namespace].get(backup(plan, account));
          fail(saved && hash(saved) === entry.digest); return saved;
        }
        return raw;
      },
      put: async () => { fail(false); },
    }])) as unknown as Record<UserStorageNamespace, ProtectedStore>;
  }
  private budget(): () => void {
    let end = performance.now() + 140000;
    return () => {
      this.assertCurrent();
      requireWallet(performance.now() < end, "WALLET_STORAGE_MIGRATION_PENDING", "Continue the same migration to finish its verified records.");
      end = performance.now() + 140000; this.progress();
    };
  }
  async plan(): Promise<UserStorageMigrationPlan> {
    this.assertCurrent();
    const checkTime = this.budget();
    const base = await this.registry.activation();
    fail(!base?.generations[this.payment]);
    for (const other of ["m4-testnet", "mainnet"] as const) {
      if (other === this.payment || base?.generations[other]) continue;
      const pending = await this.registry.stores.general.get(`${userStorageTransition}:${other}`);
      try { requireWallet(pending === null, "WALLET_STORAGE_MIGRATION_PENDING", "Finish the original migration before starting another domain."); }
      finally { pending?.fill(0); }
    }
    const existing = await this.registry.stores.general.get(this.journal());
    try { this.assertCurrent(); if (existing) return parsePlan(existing); } finally { existing?.fill(0); }
    const frozen = await this.freeze(this.domains(base));
    try {
      const snapshot = await frozen.inspect(frozen.legacy), entries: Entry[] = [];
      checkTime();
      let total = 0;
      for (const namespace of this.domains(base)) {
        for (const account of (await this.registry.stores[namespace].listLegacyAccounts()).sort()) {
          fail(!account.startsWith("migration-backup:") && (namespace !== "general" || account.startsWith("local-v1:")));
          const bytes = await frozen.legacy[namespace].get(account);
          try { fail(bytes); total += bytes.byteLength; fail(entries.length < 4096 && total <= 32 * 1048576); entries.push({ namespace, account, digest: hash(bytes), size: bytes.byteLength,
            fence: snapshot.fences.some(f => f.namespace === namespace && f.account === account) }); }
          finally { bytes?.fill(0); }
          checkTime();
        }
      }
      fail(entries.length > 0 && entries.every(e => snapshot.fences.some(f => f.namespace === e.namespace)) && snapshot.fences.every(f => entries.some(e => e.fence && e.namespace === f.namespace && e.account === f.account)));
      const result = { version: 2 as const, generation: randomUUID(), snapshotDigest: snapshot.digest, entries, payment: this.payment, base };
      this.assertCurrent(); return parsePlan(encode(result));
    } finally { await frozen.close(); }
  }
  async execute(approved: UserStorageMigrationPlan): Promise<UserStorageActivation> {
    this.assertCurrent();
    const checkTime = this.budget();
    const plan = parsePlan(encode(approved));
    const active = await this.registry.activation();
    fail(plan.payment === this.payment);
    if (active?.generations[this.payment] === plan.generation) return active;
    fail(canonical(active) === canonical(plan.base));
    const frozen = await this.freeze(this.domains(plan.base));
    try {
      const original = this.original(plan, frozen);
      const inspect = async () => {
        const snapshot = await frozen.inspect(original);
        fail(snapshot.digest === plan.snapshotDigest &&
          canonical(snapshot.fences) === canonical(plan.entries.filter(e => e.fence).map(({ namespace, account }) => ({ namespace, account }))));
      };
      await inspect(); checkTime();
      for (const namespace of this.domains(plan.base)) {
        const expected = new Set(plan.entries.filter(e => e.namespace === namespace).map(e => e.account));
        const allowedBackups = new Set(plan.entries.filter(e => e.namespace === namespace && e.fence).map(e => backup(plan, e.account)));
        const found = await this.registry.stores[namespace].listLegacyAccounts();
        fail(found.every(name => expected.has(name) || allowedBackups.has(name)) && [...expected].every(name => found.includes(name)));
      }
      await writeVerified(this.registry.stores.general, this.journal(), encode(plan), this.assertCurrent);
      for (const e of plan.entries) {
        const bytes = await original[e.namespace].get(e.account);
        try {
          fail(bytes && bytes.byteLength === e.size && hash(bytes) === e.digest);
          await writeVerified(this.registry.stores[e.namespace], physicalUserAccount(plan.generation, e.account), bytes, this.assertCurrent);
          if (e.fence) await writeVerified(frozen.legacy[e.namespace], backup(plan, e.account), bytes, this.assertCurrent);
        } finally { bytes?.fill(0); }
        checkTime();
      }
      await inspect(); checkTime();
      for (const e of plan.entries.filter(e => e.fence)) {
        checkTime();
        const store = frozen.legacy[e.namespace], tombstone = fence(plan);
        const before = await store.get(e.account);
        let alreadyFenced = false;
        try { this.assertCurrent(); alreadyFenced = !!before && hash(before) === hash(tombstone); fail(before && (hash(before) === e.digest || alreadyFenced)); }
        finally { before?.fill(0); }
        if (alreadyFenced) continue;
        let failure: unknown;
        try { this.assertCurrent(); await store.put(e.account, tombstone); } catch (error) { failure = error; }
        const after = await store.get(e.account);
        try { if (!after || hash(after) !== hash(tombstone)) { if (failure) throw failure; fail(false); } }
        finally { after?.fill(0); }
      }
      checkTime();
      frozen.prepareActivation?.();
      await inspect();
      const generations = { ...plan.base?.generations };
      for (const namespace of this.domains(plan.base)) {
        fail(namespace !== "testnet"); generations[namespace] = plan.generation;
      }
      const activation: UserStorageActivation = { version: 2, state: "active", generation: plan.generation, kind: "migrated", generations };
      fail(canonical(await this.registry.activation()) === canonical(plan.base));
      this.assertCurrent();
      let publicationError: unknown;
      try { await this.registry.stores.general.put(userStorageRoot, encode(activation)); } catch (error) { publicationError = error; }
      if (canonical(await this.registry.activation()) !== canonical(activation)) { if (publicationError) throw publicationError; fail(false); }
      return activation;
    } finally { await frozen.close(); }
  }
}
