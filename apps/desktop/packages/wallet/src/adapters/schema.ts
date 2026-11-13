export const SCHEMA_VERSION = 4;
export const GENERAL_SOURCE_SCHEMA_VERSION = 5;
export const SCHEMA_V1 = `
CREATE TABLE wallet_metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE wallet_settings (singleton INTEGER PRIMARY KEY CHECK(singleton=1), document TEXT NOT NULL CHECK(json_valid(document))) STRICT;
CREATE TABLE wallets (
 wallet_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, address TEXT NOT NULL CHECK(address = lower(address)),
 network TEXT NOT NULL, key_ref TEXT NOT NULL, document TEXT NOT NULL CHECK(json_valid(document)),
 UNIQUE(owner_id, network, address)
) STRICT;
CREATE TABLE budget_subjects (
 subject_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, address TEXT NOT NULL CHECK(address = lower(address)),
 network TEXT NOT NULL, asset TEXT NOT NULL CHECK(asset = lower(asset)), document TEXT NOT NULL CHECK(json_valid(document)),
 UNIQUE(owner_id, address, network, asset)
) STRICT;
CREATE TABLE wallet_policies (
 subject_id TEXT PRIMARY KEY REFERENCES budget_subjects(subject_id), version INTEGER NOT NULL,
 document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;
CREATE TABLE client_registrations (
 client_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, generation INTEGER NOT NULL,
 document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;
CREATE TABLE client_sessions (
 session_id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES client_registrations(client_id),
 generation INTEGER NOT NULL, document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;
CREATE TABLE payment_grants (
 grant_id TEXT PRIMARY KEY, subject_id TEXT NOT NULL REFERENCES budget_subjects(subject_id),
 version INTEGER NOT NULL, document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;
CREATE TABLE payment_permits (
 permit_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;
CREATE TABLE payment_intents (
 intent_id TEXT PRIMARY KEY, subject_id TEXT NOT NULL REFERENCES budget_subjects(subject_id),
 request_id TEXT NOT NULL, status TEXT NOT NULL, document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;
CREATE TABLE authorizations (
 intent_id TEXT PRIMARY KEY REFERENCES payment_intents(intent_id), network TEXT NOT NULL,
 asset TEXT NOT NULL CHECK(asset = lower(asset)), payer TEXT NOT NULL CHECK(payer = lower(payer)), nonce TEXT NOT NULL CHECK(nonce = lower(nonce)),
 document TEXT NOT NULL CHECK(json_valid(document)), UNIQUE(network, asset, payer, nonce)
) STRICT;
CREATE UNIQUE INDEX payment_client_request ON payment_intents(json_extract(document, '$.clientId'), request_id);
CREATE TABLE budget_reservations (
 intent_id TEXT PRIMARY KEY REFERENCES payment_intents(intent_id), amount_atomic TEXT NOT NULL,
 document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;
CREATE TABLE ledger_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
 subject_id TEXT NOT NULL REFERENCES budget_subjects(subject_id), intent_id TEXT,
 kind TEXT NOT NULL, reserved_delta TEXT NOT NULL, spent_delta TEXT NOT NULL,
 settled_at INTEGER, recorded_at INTEGER NOT NULL, evidence_key TEXT,
 document TEXT NOT NULL CHECK(json_valid(document)), previous_hash TEXT NOT NULL, event_hash TEXT NOT NULL UNIQUE
) STRICT;
CREATE INDEX ledger_subject ON ledger_events(subject_id, sequence);
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger_events BEGIN SELECT RAISE(ABORT, 'Ledger events are append-only'); END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger_events BEGIN SELECT RAISE(ABORT, 'Ledger events are append-only'); END;
CREATE TABLE settlement_observations (
 observation_id TEXT PRIMARY KEY, intent_id TEXT NOT NULL REFERENCES payment_intents(intent_id),
 network TEXT NOT NULL, tx_hash TEXT NOT NULL CHECK(tx_hash = lower(tx_hash)), log_index INTEGER NOT NULL,
 document TEXT NOT NULL CHECK(json_valid(document)), UNIQUE(network, tx_hash, log_index)
) STRICT;
CREATE TABLE control_anchors (
 singleton INTEGER PRIMARY KEY CHECK(singleton = 1), document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;
CREATE TABLE recovery_sessions (
 recovery_id TEXT PRIMARY KEY, subject_id TEXT NOT NULL REFERENCES budget_subjects(subject_id),
 document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;
CREATE TABLE audit_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
 document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'Audit events are append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'Audit events are append-only'); END;
CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT;
`;

export const TRANSPORT_SCHEMA = `
DROP INDEX payment_client_request;
CREATE UNIQUE INDEX payment_client_request ON payment_intents(json_extract(document, '$.clientId'), request_id) WHERE json_extract(document, '$.reserved')=1;
CREATE TABLE transport_metadata (singleton INTEGER PRIMARY KEY CHECK(singleton=1), document TEXT NOT NULL CHECK(json_valid(document))) STRICT;
CREATE TABLE operations (request_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, client_id TEXT NOT NULL, operation_id TEXT NOT NULL, input_digest TEXT NOT NULL, UNIQUE(owner_id,client_id,operation_id)) STRICT;
CREATE TABLE http_requests (request_id TEXT PRIMARY KEY REFERENCES operations(request_id), document TEXT NOT NULL CHECK(json_valid(document))) STRICT;
CREATE TABLE credential_references (ref TEXT PRIMARY KEY, document TEXT NOT NULL CHECK(json_valid(document))) STRICT;
CREATE TABLE client_tokens (client_id TEXT PRIMARY KEY REFERENCES client_registrations(client_id), document TEXT NOT NULL CHECK(json_valid(document))) STRICT;
CREATE TABLE controlled_bodies (ref TEXT PRIMARY KEY, document TEXT NOT NULL CHECK(json_valid(document))) STRICT;
`;
export const SCHEMA_V2 = SCHEMA_V1 + TRANSPORT_SCHEMA;
export const RETENTION_SCHEMA = `
CREATE TABLE response_retentions (retention_id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES http_requests(request_id), document TEXT NOT NULL CHECK(json_valid(document))) STRICT;
`;
export const SCHEMA_V3 = SCHEMA_V2 + RETENTION_SCHEMA;
export const JOURNAL_ANCHOR_SCHEMA = `
CREATE TABLE journal_anchors (client_id TEXT PRIMARY KEY, document TEXT NOT NULL CHECK(json_valid(document))) STRICT;
`;
export const SCHEMA = SCHEMA_V3 + JOURNAL_ANCHOR_SCHEMA;
/** Additive source identities only. Existing legacy wallet documents and key
 * references remain byte-for-byte unchanged. Applying this to an existing
 * database requires the separately authorized protected migration owner. */
export const GENERAL_SOURCE_SCHEMA = `
CREATE TABLE general_wallet_sources (
 wallet_id TEXT PRIMARY KEY, subject_id TEXT NOT NULL REFERENCES budget_subjects(subject_id) DEFERRABLE INITIALLY DEFERRED,
 owner_id TEXT NOT NULL, network TEXT NOT NULL, asset TEXT NOT NULL CHECK(asset = lower(asset)),
 address TEXT NOT NULL CHECK(address = lower(address)),
 installation_id TEXT NOT NULL, enrollment_id TEXT NOT NULL, profile_id TEXT NOT NULL, source_id TEXT NOT NULL,
 source_commitment TEXT NOT NULL, wallet_position INTEGER NOT NULL UNIQUE CHECK(wallet_position >= 0),
 document TEXT NOT NULL CHECK(json_valid(document)),
 UNIQUE(owner_id, network, asset, address),
 UNIQUE(installation_id, enrollment_id, profile_id, source_id, network, asset)
) STRICT;
`;
