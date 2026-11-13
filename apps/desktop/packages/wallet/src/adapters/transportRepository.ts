import type { WalletState } from "../app/state.js";
import { WalletDatabase, SqlBatch } from "./database.js";
import { canonical } from "./canonical.js";
import { requireWallet } from "../domain/errors.js";
export function readTransport(database: WalletDatabase): WalletState["transport"] {
  const transportRow = database.connection
    .prepare("SELECT document FROM transport_metadata WHERE singleton=1")
    .get();
  const transport = transportRow ? JSON.parse(String(transportRow.document)) : undefined;
  if (!transport) {
    for (const table of [
      "operations",
      "http_requests",
      "credential_references",
      "client_tokens",
      "controlled_bodies",
      "response_retentions",
      "journal_anchors",
    ])
      requireWallet(
        database.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n === 0,
        "LEDGER_CORRUPT",
        "Transport records require continuity metadata.",
      );
  }
  if (transport) {
    const docs = (table: string, key: string, field: string) =>
      database.connection
        .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
        .all()
        .map((row) => {
          const document = JSON.parse(String(row.document));
          requireWallet(
            document &&
              typeof document === "object" &&
              !Array.isArray(document) &&
              row[key] === document[field],
            "LEDGER_CORRUPT",
            "A transport index disagrees with its document identity.",
          );
          return document;
        });
    transport.requests = docs("http_requests", "request_id", "requestId");
    transport.credentials = docs("credential_references", "ref", "ref");
    transport.tokens = docs("client_tokens", "client_id", "clientId");
    transport.bodies = docs("controlled_bodies", "ref", "ref");
    requireWallet(!Object.hasOwn(transport, "retentions"), "LEDGER_CORRUPT",
      "Retention records must come from their indexed table.");
    requireWallet(!Object.hasOwn(transport, "journalAnchors"), "LEDGER_CORRUPT",
      "Journal anchors must come from their indexed table.");
    const anchors = docs("journal_anchors", "client_id", "clientId");
    if (anchors.length) transport.journalAnchors = anchors;
    const retentions = docs("response_retentions", "retention_id", "retentionId");
    if (retentions.length) transport.retentions = retentions;
    const retentionIndices = database.connection.prepare("SELECT retention_id,request_id FROM response_retentions ORDER BY rowid").all();
    requireWallet(retentionIndices.every((row, i) => row.retention_id === retentions[i]?.retentionId &&
      row.request_id === retentions[i]?.requestId), "LEDGER_CORRUPT", "Retention request indices disagree.");
    const operations = database.connection.prepare("SELECT * FROM operations ORDER BY rowid").all();
    requireWallet(
      operations.length === transport.requests.length &&
        operations.every((row) => {
          const record = transport.requests.find(
            (record: { requestId: string }) => record.requestId === row.request_id,
          );
          if (!record) return false;
          return (
            row.request_id === record.requestId &&
            row.owner_id === record.ownerId &&
            row.client_id === record.clientId &&
            row.operation_id === record.operationId &&
            row.input_digest === record.inputDigest
          );
        }),
      "LEDGER_CORRUPT",
      "Operation indices disagree with request records.",
    );
  }

  return transport;
}

export function persistTransport(
  sql: SqlBatch,
  state: NonNullable<WalletState["transport"]>,
): void {
  const { requests, credentials, tokens, bodies, retentions, journalAnchors, ...metadata } = state;
  sql
    .prepare(
      "INSERT INTO transport_metadata VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET document=excluded.document",
    )
    .run(canonical(metadata));
  for (const r of requests) {
    sql
      .prepare("INSERT INTO operations VALUES(?,?,?,?,?) ON CONFLICT(request_id) DO NOTHING")
      .run(r.requestId, r.ownerId, r.clientId, r.operationId, r.inputDigest);
    sql
      .prepare(
        "INSERT INTO http_requests VALUES(?,?) ON CONFLICT(request_id) DO UPDATE SET document=excluded.document",
      )
      .run(r.requestId, canonical(r));
  }
  for (const a of journalAnchors ?? []) sql.prepare(
    "INSERT INTO journal_anchors VALUES(?,?) ON CONFLICT(client_id) DO UPDATE SET document=excluded.document",
  ).run(a.clientId, canonical(a));
  for (const r of retentions ?? []) sql.prepare(
    "INSERT INTO response_retentions VALUES(?,?,?) ON CONFLICT(retention_id) DO UPDATE SET document=excluded.document",
  ).run(r.retentionId, r.requestId, canonical(r));
  for (const [table, rows, key] of [
    ["credential_references", credentials, "ref"],
    ["client_tokens", tokens, "clientId"],
    ["controlled_bodies", bodies, "ref"],
  ] as const)
    for (const row of rows)
      sql
        .prepare(
          `INSERT INTO ${table} VALUES(?,?) ON CONFLICT(${key === "clientId" ? "client_id" : "ref"}) DO UPDATE SET document=excluded.document`,
        )
        .run((row as unknown as Record<string, string>)[key]!, canonical(row));
}
