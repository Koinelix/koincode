#include "native-journal-append.h"
#include "native-journal-private.h"

static bool same_head(const general_native_head *head, const general_native_head *expected) {
  return general_native_head_same_identity(head, &expected->identity) && head->sequence == expected->sequence && !strcmp(head->head_digest, expected->head_digest);
}
static bool candidate(sqlite3 *db, const general_native_head *expected, const general_native_event *event,
  const unsigned char *body, size_t size, const char *digest, const general_native_scope_resolver *resolver, lifetime *life, bool existing) {
  general_native_head proposed = *expected; proposed.sequence = event->sequence; memcpy(proposed.head_digest, digest, 65);
  general_native_replay *replay = general_native_replay_create(&proposed, resolver);
  if (!replay) return false;
  bool ok = metadata(db) && active(life) && rows(db, replay, life) && active(life) &&
    (existing || general_native_replay_feed(replay, body, size, digest)) && general_native_replay_seal(replay) == GENERAL_NATIVE_REPLAY_MATCHED && active(life);
  general_native_replay_destroy(&replay); return ok;
}
static bool insert(sqlite3 *db, uint64_t sequence, const unsigned char *body, size_t size, const char *digest) {
  sqlite3_stmt *row = NULL;
  bool ok = sqlite3_prepare_v2(db, "INSERT INTO main.events(sequence,body,digest) VALUES(?,?,?)", -1, &row, NULL) == SQLITE_OK && row &&
    sqlite3_bind_int64(row, 1, (sqlite3_int64)sequence) == SQLITE_OK && sqlite3_bind_text(row, 2, (const char *)body, (int)size, SQLITE_TRANSIENT) == SQLITE_OK &&
    sqlite3_bind_text(row, 3, digest, 64, SQLITE_TRANSIENT) == SQLITE_OK && sqlite3_step(row) == SQLITE_DONE;
  if (sqlite3_finalize(row) != SQLITE_OK) ok = false;
  return ok;
}
static bool readback(sqlite3 *db, uint64_t sequence, const unsigned char *body, size_t size, const char *digest) {
  sqlite3_stmt *row = prepare(db, "SELECT sequence,body,digest FROM main.events WHERE sequence=?");
  bool ok = row && sqlite3_bind_int64(row, 1, (sqlite3_int64)sequence) == SQLITE_OK && sqlite3_step(row) == SQLITE_ROW &&
    sqlite3_column_type(row, 0) == SQLITE_INTEGER && sqlite3_column_int64(row, 0) == (sqlite3_int64)sequence &&
    sqlite3_column_type(row, 1) == SQLITE_TEXT && sqlite3_column_bytes(row, 1) == (int)size;
  const unsigned char *actual = ok ? sqlite3_column_text(row, 1) : NULL;
  ok = ok && actual && !memcmp(actual, body, size) && text(row, 2, digest) && sqlite3_step(row) == SQLITE_DONE;
  if (sqlite3_finalize(row) != SQLITE_OK) ok = false;
  return ok;
}
static general_native_append_status apply(sqlite3 *db, const general_native_head *expected,
  const general_native_event *event, const general_session_installation *installation, const general_native_scope_resolver *resolver,
  bool (*current)(void *), void *context, bool existing) {
  if (!db || !current || !installation || !general_native_head_valid(expected) || !general_native_event_valid(event) ||
      expected->sequence >= GENERAL_NATIVE_EVENT_LIMIT || event->sequence != expected->sequence + 1 || strcmp(event->previous_digest, expected->head_digest) ||
      sqlite3_db_readonly(db, "main") != 0 || !sqlite3_get_autocommit(db) || sqlite3_next_stmt(db, NULL)) return GENERAL_NATIVE_APPEND_REJECTED;
  /* Freeze the original metadata before any lifetime callback or OS IO. */
  general_native_head original = *expected; general_native_event change = *event; general_session_installation pinned = *installation;
  general_native_scope_resolver scope = {0}; if (resolver) scope = *resolver;
  unsigned char body[GENERAL_NATIVE_EVENT_MAX]; size_t size; char digest[65];
  if (!general_native_event_encode(&change, body, sizeof(body), &size) || !general_native_event_digest(&change, digest)) return GENERAL_NATIVE_APPEND_REJECTED;
  lifetime life = { .current = current, .context = context };
  if (clock_gettime(CLOCK_MONOTONIC, &life.started) || !active(&life)) return GENERAL_NATIVE_APPEND_REJECTED;
  sqlite3_progress_handler(db, 1000, progress, &life);
  bool began = configure(db) && active(&life) && sqlite3_exec(db, "BEGIN IMMEDIATE", NULL, NULL, NULL) == SQLITE_OK;
  general_native_append_status result = GENERAL_NATIVE_APPEND_REJECTED;
  general_native_head actual;
  if (!began || !active(&life) || general_native_anchor_read(&original.identity, &pinned, journal_current, &life, &actual) != GENERAL_NATIVE_ANCHOR_FOUND ||
      !same_head(&actual, &original) || !active(&life) || !candidate(db, &original, &change, body, size, digest, &scope, &life, existing) || !active(&life)) goto finished;
  if (existing) {
    if (!readback(db, change.sequence, body, size, digest) || !active(&life)) goto finished;
    result = GENERAL_NATIVE_APPEND_UNCERTAIN;
  } else {
    if (!insert(db, change.sequence, body, size, digest) || !active(&life) || !metadata(db) || !active(&life)) goto finished;
    result = GENERAL_NATIVE_APPEND_UNCERTAIN;
    if (sqlite3_exec(db, "COMMIT", NULL, NULL, NULL) != SQLITE_OK || !sqlite3_get_autocommit(db) || !active(&life) ||
        !readback(db, change.sequence, body, size, digest) || !active(&life)) goto finished;
  }
  if (general_native_anchor_advance(&original, &change, &pinned, journal_current, &life) == GENERAL_NATIVE_ANCHOR_ADVANCED && active(&life)) result = GENERAL_NATIVE_APPEND_ANCHORED;
finished:
  sqlite3_progress_handler(db, 0, NULL, NULL);
  /* The dedicated connection had no caller transaction on entry. */
  if (!sqlite3_get_autocommit(db)) {
    if (sqlite3_exec(db, "ROLLBACK", NULL, NULL, NULL) != SQLITE_OK || !sqlite3_get_autocommit(db)) result = GENERAL_NATIVE_APPEND_UNCERTAIN;
  }
  if (result == GENERAL_NATIVE_APPEND_ANCHORED && !active(&life)) result = GENERAL_NATIVE_APPEND_UNCERTAIN;
  return result;
}
general_native_append_status general_native_journal_append(sqlite3 *db, const general_native_head *expected,
  const general_native_event *event, const general_session_installation *installation, const general_native_scope_resolver *resolver,
  bool (*current)(void *), void *context) {
  return apply(db, expected, event, installation, resolver, current, context, false);
}
general_native_append_status general_native_journal_recover_tail(sqlite3 *db, const general_native_head *expected,
  const general_native_event *event, const general_session_installation *installation, const general_native_scope_resolver *resolver,
  bool (*current)(void *), void *context) {
  return apply(db, expected, event, installation, resolver, current, context, true);
}
