import { validateJournalAnchors, validateJournalTransition } from "./journalIntegrity.js";
import { readTransport, persistTransport } from "./transportRepository.js";
import { stateCommitment } from "./stateCommitment.js";
import { validateResponseRetentions, validateRetentionTransition } from "./retentionIntegrity.js";
import {
  validateAuthorizationRows,
  validateDocumentRow,
  validateStateTransition,
} from "./stateIntegrity.js";
import type {
  InitializationAttempt,
  InitializationTicket,
  StateCommitment,
  StateRepository,
  WalletState,
} from "../app/state.js";
import { requireWallet } from "../domain/errors.js";
import { WalletDatabase, SqlBatch } from "./database.js";
import { canonical, digest, eventHash } from "./canonical.js";
import { readGeneralPaymentSources, persistGeneralPaymentSources, validateGeneralPaymentSources } from "./generalPaymentSourceRepository.js";
import { GENERAL_SOURCE_SCHEMA_VERSION } from "./schema.js";

const GENESIS = "0".repeat(64);
const DOCUMENT_TABLES = new Set([
  "wallets",
  "audit_events",
  "settlement_observations",
  "recovery_sessions",
  "budget_subjects",
  "wallet_policies",
  "client_registrations",
  "client_sessions",
  "payment_grants",
  "payment_permits",
  "payment_intents",
]);
export class SqliteWalletRepository implements StateRepository {
  constructor(private readonly database: WalletDatabase) {}
  private documents<T>(table: string): T[] {
    requireWallet(DOCUMENT_TABLES.has(table), "INVALID_TABLE", "Unknown wallet table.");
    return this.database.connection
      .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
      .all()
      .map((row) => {
        const document = JSON.parse(String(row.document)) as T;
        validateDocumentRow(table, row, document);
        return document;
      });
  }
  read(): WalletState {
    const meta = Object.fromEntries(
      this.database.connection
        .prepare("SELECT name,value FROM wallet_metadata")
        .all()
        .map((row) => [String(row.name), String(row.value)]),
    );
    requireWallet(
      meta.installation_id &&
        meta.owner_id &&
        meta.management_epoch &&
        meta.revision &&
        meta.trusted_time,
      "LEDGER_CORRUPT",
      "Wallet identity metadata is incomplete.",
    );
    let head = GENESIS;
    const events = this.database.connection
      .prepare("SELECT * FROM ledger_events ORDER BY sequence")
      .all()
      .map((row) => {
        const event = JSON.parse(String(row.document));
        const next = eventHash(head, event);
        requireWallet(
          row.previous_hash === head &&
            row.event_hash === next &&
            event.eventId === row.event_id &&
            event.subjectId === row.subject_id &&
            event.intentId === row.intent_id &&
            event.kind === row.kind &&
            event.reservedDelta === row.reserved_delta &&
            event.spentDelta === row.spent_delta &&
            event.settledAt === row.settled_at &&
            event.recordedAt === row.recorded_at &&
            event.evidenceKey === row.evidence_key,
          "LEDGER_CORRUPT",
          "The wallet ledger hash chain is inconsistent.",
        );
        head = next;
        return event;
      });
    const policyRows = this.documents<{
      subjectId: string;
      limits: WalletState["policies"][string];
    }>("wallet_policies");
    const transport = readTransport(this.database);
    const state: WalletState = {
      ...(transport ? { transport } : {}),
      installationId: meta.installation_id,
      ownerId: meta.owner_id,
      managementEpoch: meta.management_epoch,
      initializationAttempt: meta.initialization_attempt ?? "",
      revision: Number(meta.revision),
      trustedTime: Number(meta.trusted_time),
      defaultWalletId: (() => {
        const row = this.database.connection
          .prepare("SELECT document FROM wallet_settings WHERE singleton=1")
          .get();
        return row ? (JSON.parse(String(row.document)).defaultWalletId as string) : null;
      })(),
      auditEvents: this.documents("audit_events"),
      observations: this.documents("settlement_observations"),
      recoveries: this.documents("recovery_sessions"),
      wallets: readGeneralPaymentSources(this.database, this.documents("wallets"), meta.owner_id),
      subjects: this.documents("budget_subjects"),
      policies: Object.fromEntries(policyRows.map((row) => [row.subjectId, row.limits])),
      clients: this.documents("client_registrations"),
      sessions: this.documents("client_sessions"),
      grants: this.documents("payment_grants"),
      permits: this.documents("payment_permits"),
      intents: this.documents("payment_intents"),
      events,
    };
    requireWallet(
      Number.isSafeInteger(state.revision) &&
        state.revision >= 0 &&
        Number.isSafeInteger(state.trustedTime) &&
        state.trustedTime >= 0,
      "LEDGER_CORRUPT",
      "Wallet revision and time metadata are invalid.",
    );
    requireWallet(
      this.database.connection
        .prepare("SELECT owner_id FROM wallets")
        .all()
        .every((row) => row.owner_id === state.ownerId),
      "LEDGER_CORRUPT",
      "Wallet ownership metadata is inconsistent.",
    );
    validateAuthorizationRows(
      state,
      this.database.connection.prepare("SELECT * FROM authorizations").all(),
      this.database.connection.prepare("SELECT * FROM budget_reservations").all(),
    );
    validateResponseRetentions(state);
    validateJournalAnchors(state);
    validateGeneralPaymentSources(state);
    return state;
  }
  readCommitment(): StateCommitment | null {
    const row = this.database.connection
      .prepare("SELECT document FROM control_anchors WHERE singleton=1")
      .get();
    return row ? (JSON.parse(String(row.document)) as StateCommitment) : null;
  }
  commitment(
    state: WalletState,
    storageBinding = digest(this.database.directory),
  ): StateCommitment {
    return stateCommitment(state, storageBinding);
  }

  validate(previous: WalletState, next: WalletState): void {
    requireWallet(!next.wallets.some((entry) => entry.kind === "general_source") || this.database.schemaVersion === GENERAL_SOURCE_SCHEMA_VERSION,
      "SCHEMA_INCOMPATIBLE", "Protected source registration requires the explicitly upgraded schema.");
    validateStateTransition(previous, next);
    validateRetentionTransition(previous, next);
    validateJournalTransition(previous, next);
    requireWallet(
      next.events.length >= previous.events.length &&
        canonical(next.events.slice(0, previous.events.length)) === canonical(previous.events),
      "LEDGER_CORRUPT",
      "Existing ledger events cannot change.",
    );
  }
  issueInitialization(mode: "fresh" | "resume"): InitializationTicket {
    return this.database.issueInitialization(mode);
  }
  beginInitialization(ticket: InitializationTicket) {
    return this.database.beginInitialization(ticket);
  }
  isReady(): boolean {
    return this.database.isReady();
  }
  finishInitialization(
    previous: WalletState,
    next: WalletState,
    commitment: StateCommitment,
    attempt: InitializationAttempt,
  ): void {
    this.commitState(previous, next, commitment, attempt);
  }
  commit(previous: WalletState, next: WalletState, commitment: StateCommitment): void {
    requireWallet(this.database.isReady(), "WALLET_NOT_INITIALIZED", "The wallet is not ready.");
    this.commitState(previous, next, commitment);
  }
  private commitState(
    previous: WalletState,
    next: WalletState,
    commitment: StateCommitment,
    attempt?: InitializationAttempt,
  ): void {
    this.validate(previous, next);
    requireWallet(
      canonical(this.commitment(next)) === canonical(commitment),
      "STATE_CONFLICT",
      "The protected commitment does not match this transaction.",
    );
    const sql = new SqlBatch();
    if (next.transport) persistTransport(sql, next.transport);
    if (next.defaultWalletId !== null)
      sql
        .prepare(
          "INSERT INTO wallet_settings VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET document=excluded.document",
        )
        .run(canonical({ defaultWalletId: next.defaultWalletId }));
    else if (previous.defaultWalletId !== null) sql.exec("DELETE FROM wallet_settings");
    for (const event of next.auditEvents.slice(previous.auditEvents.length))
      sql
        .prepare("INSERT INTO audit_events(event_id,document) VALUES(?,?)")
        .run(event.eventId, canonical(event));
    persistGeneralPaymentSources(this.database, sql, next);
    for (const wallet of next.wallets.filter((entry) => entry.kind !== "general_source"))
      sql
        .prepare(
          "INSERT INTO wallets VALUES(?,?,?,?,?,?) ON CONFLICT(wallet_id) DO UPDATE SET key_ref=excluded.key_ref, document=excluded.document",
        )
        .run(
          wallet.walletId,
          next.ownerId,
          wallet.address.toLowerCase(),
          wallet.network,
          wallet.keyRef,
          canonical(wallet),
        );
    for (const subject of next.subjects)
      sql
        .prepare(
          "INSERT INTO budget_subjects VALUES(?,?,?,?,?,?) ON CONFLICT(subject_id) DO UPDATE SET document=excluded.document",
        )
        .run(
          subject.subjectId,
          subject.ownerId,
          subject.address.toLowerCase(),
          subject.network,
          subject.asset.toLowerCase(),
          canonical(subject),
        );
    for (const [subjectId, limits] of Object.entries(next.policies))
      sql
        .prepare(
          "INSERT INTO wallet_policies VALUES(?,?,?) ON CONFLICT(subject_id) DO UPDATE SET version=excluded.version, document=excluded.document",
        )
        .run(subjectId, limits.version, canonical({ subjectId, limits }));
    for (const client of next.clients)
      sql
        .prepare(
          "INSERT INTO client_registrations VALUES(?,?,?,?) ON CONFLICT(client_id) DO UPDATE SET generation=excluded.generation,document=excluded.document",
        )
        .run(client.clientId, client.ownerId, client.generation, canonical(client));
    sql.exec("DELETE FROM client_sessions");
    for (const session of next.sessions)
      sql
        .prepare("INSERT INTO client_sessions VALUES(?,?,?,?)")
        .run(session.sessionId, session.clientId, session.generation, canonical(session));
    for (const grant of next.grants)
      sql
        .prepare(
          "INSERT INTO payment_grants VALUES(?,?,?,?) ON CONFLICT(grant_id) DO UPDATE SET version=excluded.version,document=excluded.document",
        )
        .run(grant.grantId, grant.subjectId, grant.version, canonical(grant));
    for (const permit of next.permits)
      sql
        .prepare(
          "INSERT INTO payment_permits VALUES(?,?,?) ON CONFLICT(permit_id) DO UPDATE SET document=excluded.document",
        )
        .run(permit.permitId, permit.requestId, canonical(permit));
    for (const intent of next.intents) {
      sql
        .prepare(
          "INSERT INTO payment_intents VALUES(?,?,?,?,?) ON CONFLICT(intent_id) DO UPDATE SET status=excluded.status,document=excluded.document",
        )
        .run(intent.intentId, intent.subjectId, intent.requestId, intent.status, canonical(intent));
      sql
        .prepare(
          "INSERT INTO authorizations VALUES(?,?,?,?,?,?) ON CONFLICT(intent_id) DO UPDATE SET document=excluded.document",
        )
        .run(
          intent.intentId,
          intent.network,
          intent.asset.toLowerCase(),
          next.subjects
            .find((subject) => subject.subjectId === intent.subjectId)!
            .address.toLowerCase(),
          intent.nonce.toLowerCase(),
          canonical({
            validAfter: intent.validAfter,
            validBefore: intent.validBefore,
            anchorBlock: intent.anchorBlock,
            anchorHash: intent.anchorHash,
          }),
        );
      sql
        .prepare(
          "INSERT INTO budget_reservations VALUES(?,?,?) ON CONFLICT(intent_id) DO UPDATE SET amount_atomic=excluded.amount_atomic,document=excluded.document",
        )
        .run(
          intent.intentId,
          intent.reserved ? intent.amountAtomic : "0",
          canonical({ active: intent.reserved }),
        );
    }
    let head = previous.events.reduce((hash, event) => eventHash(hash, event), GENESIS);
    for (const event of next.events.slice(previous.events.length)) {
      const hash = eventHash(head, event);
      sql
        .prepare(
          "INSERT INTO ledger_events(event_id,subject_id,intent_id,kind,reserved_delta,spent_delta,settled_at,recorded_at,evidence_key,document,previous_hash,event_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          event.eventId,
          event.subjectId,
          event.intentId,
          event.kind,
          event.reservedDelta,
          event.spentDelta,
          event.settledAt,
          event.recordedAt,
          event.evidenceKey,
          canonical(event),
          head,
          hash,
        );
      head = hash;
    }
    for (const recovery of next.recoveries)
      sql
        .prepare(
          "INSERT INTO recovery_sessions VALUES(?,?,?) ON CONFLICT(recovery_id) DO UPDATE SET document=excluded.document",
        )
        .run(recovery.recoveryId, recovery.subjectId, canonical(recovery));
    for (const observation of next.observations)
      sql
        .prepare(
          "INSERT INTO settlement_observations VALUES(?,?,?,?,?,?) ON CONFLICT(observation_id) DO UPDATE SET document=excluded.document",
        )
        .run(
          observation.observationId,
          observation.intentId,
          observation.network,
          observation.txHash.toLowerCase(),
          observation.logIndex,
          canonical(observation),
        );
    const put = sql.prepare("UPDATE wallet_metadata SET value=? WHERE name=?");
    put.run(String(next.revision), "revision");
    put.run(next.managementEpoch, "management_epoch");
    put.run(String(next.trustedTime), "trusted_time");
    sql
      .prepare(
        "INSERT INTO control_anchors VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET document=excluded.document",
      )
      .run(canonical(commitment));
    if (attempt) this.database.finishInitialization(attempt, sql.commands);
    else this.database.transaction(sql.commands, previous.revision);
  }
  close(): void {
    this.database.close();
  }
}
