import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA, SCHEMA_VERSION, GENERAL_SOURCE_SCHEMA, GENERAL_SOURCE_SCHEMA_VERSION } from "./schema.js";
import { digest, canonical } from "./canonical.js";
import { requireWallet } from "../domain/errors.js";
import type { InitializationAttempt, InitializationTicket } from "../app/state.js";

interface Binding {
  store: DatabaseSync;
  directory: string;
  fileId: string;
  metadata: Record<string, string>;
  schema: string;
  attemptId: string;
  mode: "fresh" | "resume";
}
const freshStores = new WeakMap<DatabaseSync, Record<string, string>>();
const openedStores = new WeakMap<DatabaseSync, { directory: string; fileId: string }>();
const tickets = new WeakMap<InitializationTicket, Binding>();
const attempts = new WeakMap<InitializationAttempt, Binding>();
const METADATA_KEYS = [
  "initialization_attempt",
  "initialization_state",
  "installation_id",
  "management_epoch",
  "owner_id",
  "revision",
  "trusted_time",
]
  .sort()
  .join();
const expectedSchemas = new Map<number, string>();
function schemaDigest(store: DatabaseSync): string {
  return digest(
    store.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
  );
}
function trustedSchema(version: number): string | undefined {
  if (version !== SCHEMA_VERSION && version !== GENERAL_SOURCE_SCHEMA_VERSION) return undefined;
  if (!expectedSchemas.has(version)) {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(SCHEMA);
      if (version === GENERAL_SOURCE_SCHEMA_VERSION) db.exec(GENERAL_SOURCE_SCHEMA);
      expectedSchemas.set(version, schemaDigest(db));
    } finally {
      db.close();
    }
  }
  return expectedSchemas.get(version);
}
function metadata(store: DatabaseSync): Record<string, string> {
  return Object.fromEntries(
    store
      .prepare("SELECT name,value FROM wallet_metadata")
      .all()
      .map((row) => [String(row.name), String(row.value)]),
  );
}
function fileId(directory: string): string {
  const stat = statSync(join(directory, "wallet.sqlite"), { bigint: true });
  return `${stat.dev}:${stat.ino}`;
}
function pristine(store: DatabaseSync, ready = false): Record<string, string> {
  const version = Number(store.prepare("PRAGMA user_version").get()?.user_version);
  requireWallet(
    schemaDigest(store) === trustedSchema(version),
    "INITIALIZATION_NOT_PRISTINE",
    "The wallet schema does not match its authoritative migration.",
  );
  const meta = metadata(store);
  requireWallet(
    Object.keys(meta).sort().join() === METADATA_KEYS &&
      meta.trusted_time === "0" &&
      meta.revision === (ready ? "1" : "0"),
    "INITIALIZATION_NOT_PRISTINE",
    "The wallet metadata is not an unused setup state.",
  );
  requireWallet(
    meta.installation_id && meta.owner_id && meta.management_epoch,
    "INITIALIZATION_NOT_PRISTINE",
    "Initial wallet identities are missing.",
  );
  const phase = ready ? "READY" : meta.initialization_state;
  requireWallet(
    (ready && meta.initialization_state === "READY") ||
      phase === "PRISTINE" ||
      phase === "INITIALIZING",
    "INITIALIZATION_NOT_PRISTINE",
    "The database is outside its initialization phases.",
  );
  requireWallet(
    phase === "PRISTINE"
      ? meta.initialization_attempt === ""
      : /^[0-9a-f-]{36}$/.test(meta.initialization_attempt ?? ""),
    "INITIALIZATION_NOT_PRISTINE",
    "The setup attempt identity is invalid.",
  );
  const migration = store.prepare("SELECT * FROM schema_migrations").all();
  requireWallet(
    migration.length === 1 && migration[0]?.version === version,
    "INITIALIZATION_NOT_PRISTINE",
    "The migration history is not a fresh schema.",
  );
  for (const row of store.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    const name = String(row.name);
    if (name === "wallet_metadata" || name === "schema_migrations") continue;
    const count = Number(
      store.prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get()?.n,
    );
    requireWallet(
      count === (ready && name === "control_anchors" ? 1 : 0),
      "INITIALIZATION_NOT_PRISTINE",
      "An initialization database must contain no application history.",
    );
  }
  return meta;
}
export function markOpenedStore(store: DatabaseSync, directory: string): void {
  openedStores.set(store, { directory, fileId: fileId(directory) });
}
export function markFreshStore(store: DatabaseSync): void {
  freshStores.set(store, metadata(store));
}
export function issueInitialization(
  store: DatabaseSync,
  directory: string,
  mode: "fresh" | "resume",
): InitializationTicket {
  requireWallet(
    mode === "fresh" || mode === "resume",
    "INITIALIZATION_CAPABILITY_INVALID",
    "Unknown initialization mode.",
  );
  const opened = openedStores.get(store);
  requireWallet(
    opened && opened.directory === directory && opened.fileId === fileId(directory),
    "INITIALIZATION_CAPABILITY_INVALID",
    "The opened database file identity changed.",
  );
  if (mode === "fresh") {
    requireWallet(
      freshStores.has(store),
      "INITIALIZATION_CAPABILITY_INVALID",
      "Only an exclusively created database can issue a fresh setup capability.",
    );
    const original = freshStores.get(store)!;
    freshStores.delete(store);
    requireWallet(
      canonical(metadata(store)) === canonical(original),
      "INITIALIZATION_NOT_PRISTINE",
      "Initial identities changed after file creation.",
    );
  }
  const meta = pristine(store);
  const attemptId = meta.initialization_attempt || randomUUID();
  const ticket = Object.freeze({}) as InitializationTicket;
  tickets.set(ticket, {
    store,
    directory,
    fileId: fileId(directory),
    metadata: meta,
    schema: schemaDigest(store),
    attemptId,
    mode,
  });
  return ticket;
}
export function beginInitialization(
  store: DatabaseSync,
  directory: string,
  ticket: InitializationTicket,
): { attempt: InitializationAttempt; attemptId: string; mode: "fresh" | "resume" } {
  const binding = tickets.get(ticket);
  tickets.delete(ticket);
  requireWallet(
    binding &&
      binding.store === store &&
      binding.directory === directory &&
      binding.fileId === fileId(directory),
    "INITIALIZATION_CAPABILITY_INVALID",
    "The setup capability does not belong to this store.",
  );
  store.exec("BEGIN IMMEDIATE");
  try {
    requireWallet(
      canonical(pristine(store)) === canonical(binding.metadata),
      "INITIALIZATION_NOT_PRISTINE",
      "Wallet state changed after the setup capability was issued.",
    );
    store
      .prepare("UPDATE wallet_metadata SET value='INITIALIZING' WHERE name='initialization_state'")
      .run();
    store
      .prepare("UPDATE wallet_metadata SET value=? WHERE name='initialization_attempt'")
      .run(binding.attemptId);
    store.exec("COMMIT");
  } catch (error) {
    store.exec("ROLLBACK");
    throw error;
  }
  const attempt = Object.freeze({}) as InitializationAttempt;
  attempts.set(attempt, { ...binding, metadata: metadata(store) });
  return { attempt, attemptId: binding.attemptId, mode: binding.mode };
}
export function verifyInitializationAttempt(
  store: DatabaseSync,
  directory: string,
  attempt: InitializationAttempt,
): void {
  const binding = attempts.get(attempt);
  requireWallet(
    binding &&
      binding.store === store &&
      binding.directory === directory &&
      binding.fileId === fileId(directory) &&
      binding.schema === schemaDigest(store) &&
      canonical(pristine(store)) === canonical(binding.metadata),
    "INITIALIZATION_CAPABILITY_INVALID",
    "The initialization attempt no longer matches this store.",
  );
}
export function consumeInitializationAttempt(
  store: DatabaseSync,
  directory: string,
  attempt: InitializationAttempt,
): void {
  try {
    verifyInitializationAttempt(store, directory, attempt);
  } finally {
    attempts.delete(attempt);
  }
}
export function verifyReadyInitialState(store: DatabaseSync): void {
  pristine(store, true);
}
