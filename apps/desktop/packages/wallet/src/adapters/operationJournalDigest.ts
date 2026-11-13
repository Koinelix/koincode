import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { requireWallet } from "../domain/errors.js";
import { OPERATION_JOURNAL_LIMIT, OPERATION_SOURCE_LIMIT, type JournalDigest } from "../domain/operationJournal.js";
import { requestDigest } from "../app/requestFacts.js";

export const OPERATION_SCHEMA = "CREATE TABLE operation_sources(client_id TEXT NOT NULL, source_id TEXT NOT NULL, input_digest TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, PRIMARY KEY(client_id,source_id)) STRICT;";
let expectedSchema: string | undefined;
export function assertOperationSchema(db: DatabaseSync): void {
  const signature = (value: DatabaseSync) => requestDigest(value.prepare(
    "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
  ).all());
  if (!expectedSchema) {
    const expected = new DatabaseSync(":memory:");
    try { expected.exec(OPERATION_SCHEMA); expectedSchema = signature(expected); }
    finally { expected.close(); }
  }
  requireWallet(signature(db) === expectedSchema, "OPERATION_HISTORY_INCOMPLETE",
    "The operation journal schema differs from its authoritative format.");
}

export function operationJournalDigest(db: DatabaseSync, clientId: string): JournalDigest {
  const count = Number(db.prepare("SELECT count(*) AS n FROM operation_sources").get()?.n);
  requireWallet(Number.isSafeInteger(count) && count <= OPERATION_JOURNAL_LIMIT,
    "OPERATION_HISTORY_INCOMPLETE", "The operation journal exceeds its inventory limit.");
  const invalid = db.prepare("SELECT 1 FROM operation_sources WHERE client_id != ? OR length(source_id) > ? OR length(input_digest) != 64 OR length(operation_id) != 36 LIMIT 1").get(clientId, OPERATION_SOURCE_LIMIT);
  requireWallet(!invalid, "OPERATION_HISTORY_INCOMPLETE", "The operation journal contains invalid mappings.");
  const hash = createHash("sha256").update("[");
  let seen = 0;
  for (const row of db.prepare("SELECT * FROM operation_sources ORDER BY source_id COLLATE BINARY").iterate()) {
    requireWallet(typeof row.source_id === "string" && row.source_id.length > 0 &&
      row.source_id.length <= OPERATION_SOURCE_LIMIT && /^[0-9a-f]{64}$/.test(String(row.input_digest)) &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(row.operation_id)),
    "OPERATION_HISTORY_INCOMPLETE", "The operation journal contains invalid mappings.");
    if (seen++) hash.update(",");
    hash.update(JSON.stringify([row.client_id, row.source_id, row.input_digest, row.operation_id]));
  }
  return { count, digest: hash.update("]").digest("hex") };
}
