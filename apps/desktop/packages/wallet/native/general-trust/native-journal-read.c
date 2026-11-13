#include "native-journal-private.h"

general_native_replay *general_native_journal_snapshot_private(sqlite3 *db, int read_only, const general_native_head *anchor,
  const general_native_scope_resolver *resolver, bool (*current)(void *), void *context) {
  if (!db || !current || !general_native_head_valid(anchor) || anchor->sequence > GENERAL_NATIVE_EVENT_LIMIT ||
      sqlite3_db_readonly(db, "main") != read_only || !sqlite3_get_autocommit(db) || sqlite3_next_stmt(db, NULL)) return NULL;
  lifetime life = { .current = current, .context = context };
  if (clock_gettime(CLOCK_MONOTONIC, &life.started) || !active(&life)) return NULL;
  general_native_replay *replay = general_native_replay_create(anchor, resolver);
  if (!replay) return NULL;
  sqlite3_progress_handler(db, 1000, progress, &life);
  bool began = configure(db) && sqlite3_exec(db, "BEGIN", NULL, NULL, NULL) == SQLITE_OK;
  bool ok = began && active(&life) && metadata(db) && active(&life) && rows(db, replay, &life) &&
    general_native_replay_seal(replay) != GENERAL_NATIVE_REPLAY_INVALID && active(&life);
  if (ok) ok = sqlite3_exec(db, "COMMIT", NULL, NULL, NULL) == SQLITE_OK && active(&life);
  /* Cancellation must not interrupt our own read-transaction cleanup. */
  sqlite3_progress_handler(db, 0, NULL, NULL);
  if (began && !sqlite3_get_autocommit(db)) {
    if (sqlite3_exec(db, "ROLLBACK", NULL, NULL, NULL) != SQLITE_OK || !sqlite3_get_autocommit(db)) ok = false;
  }
  if (!ok) general_native_replay_destroy(&replay);
  return replay;
}

general_native_replay *general_native_journal_read(sqlite3 *db, const general_native_head *anchor,
  const general_native_scope_resolver *resolver, bool (*current)(void *), void *context) {
  return general_native_journal_snapshot_private(db, 1, anchor, resolver, current, context);
}
