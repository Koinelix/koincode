#ifndef KOINCODE_GENERAL_NATIVE_JOURNAL_PRIVATE_H
#define KOINCODE_GENERAL_NATIVE_JOURNAL_PRIVATE_H
/* Native-private helpers shared by the read and append paths. No persistent owner. */
#include "native-journal-read.h"
#include <string.h>
#include <time.h>

#define JOURNAL_BYTES (512ULL * 1024 * 1024)
#define JOURNAL_VM_TICKS 50000U
static const char schema[] = "CREATE TABLE events(sequence INTEGER PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL)";
typedef struct { bool (*current)(void *); void *context; struct timespec started; unsigned ticks; } lifetime;

static inline bool active(lifetime *life) {
  struct timespec now;
  if (!life->current(life->context) || clock_gettime(CLOCK_MONOTONIC, &now)) return false;
  time_t seconds = now.tv_sec - life->started.tv_sec;
  return seconds >= 0 && (seconds < 30 || (seconds == 30 && now.tv_nsec < life->started.tv_nsec));
}
static inline int progress(void *context) {
  lifetime *life = context;
  return ++life->ticks > JOURNAL_VM_TICKS || !active(life);
}
static inline bool text(sqlite3_stmt *row, int column, const char *value) {
  if (sqlite3_column_type(row, column) != SQLITE_TEXT) return false;
  int count = sqlite3_column_bytes(row, column);
  const unsigned char *bytes = sqlite3_column_text(row, column);
  return bytes && count == (int)strlen(value) && !memcmp(bytes, value, (size_t)count);
}
static inline sqlite3_stmt *prepare(sqlite3 *db, const char *sql) {
  sqlite3_stmt *out = NULL;
  if (sqlite3_prepare_v2(db, sql, -1, &out, NULL) != SQLITE_OK || !out || !sqlite3_stmt_readonly(out)) {
    sqlite3_finalize(out); return NULL;
  }
  return out;
}
static inline bool scalar(sqlite3 *db, const char *sql, sqlite3_int64 *out) {
  sqlite3_stmt *row = prepare(db, sql);
  bool ok = row && sqlite3_step(row) == SQLITE_ROW && sqlite3_column_count(row) == 1 && sqlite3_column_type(row, 0) == SQLITE_INTEGER;
  sqlite3_int64 value = ok ? sqlite3_column_int64(row, 0) : -1;
  if (ok) ok = sqlite3_step(row) == SQLITE_DONE;
  if (sqlite3_finalize(row) != SQLITE_OK) ok = false;
  if (ok) *out = value;
  return ok;
}
static inline bool single_text(sqlite3 *db, const char *sql, const char *value) {
  sqlite3_stmt *row = prepare(db, sql);
  bool ok = row && sqlite3_step(row) == SQLITE_ROW && sqlite3_column_count(row) == 1 && text(row, 0, value) && sqlite3_step(row) == SQLITE_DONE;
  if (sqlite3_finalize(row) != SQLITE_OK) ok = false;
  return ok;
}
static inline bool configure(sqlite3 *db) {
  sqlite3_limit(db, SQLITE_LIMIT_LENGTH, 8192);
  sqlite3_limit(db, SQLITE_LIMIT_SQL_LENGTH, 4096);
  sqlite3_limit(db, SQLITE_LIMIT_COLUMN, 8);
  sqlite3_limit(db, SQLITE_LIMIT_ATTACHED, 0);
  int setting;
  if (sqlite3_db_config(db, SQLITE_DBCONFIG_DEFENSIVE, 1, &setting) != SQLITE_OK || setting != 1 ||
      sqlite3_db_config(db, SQLITE_DBCONFIG_TRUSTED_SCHEMA, 0, &setting) != SQLITE_OK || setting ||
      sqlite3_busy_timeout(db, 250) != SQLITE_OK || sqlite3_exec(db, "PRAGMA main.synchronous=FULL", NULL, NULL, NULL) != SQLITE_OK) return false;
  /* Apple's system SQLite omits extension loading entirely; its toggle returns MISUSE. */
  if (!sqlite3_compileoption_used("OMIT_LOAD_EXTENSION") &&
      (sqlite3_db_config(db, SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION, 0, &setting) != SQLITE_OK || setting)) return false;
  return true;
}
static inline bool metadata(sqlite3 *db) {
  sqlite3_stmt *row = prepare(db, "PRAGMA database_list");
  bool ok = row && sqlite3_step(row) == SQLITE_ROW && text(row, 1, "main") && sqlite3_step(row) == SQLITE_DONE;
  if (sqlite3_finalize(row) != SQLITE_OK) ok = false;
  sqlite3_int64 version, page_size, pages, synchronous;
  if (!ok || !scalar(db, "PRAGMA main.user_version", &version) || version != 1 ||
      !scalar(db, "PRAGMA main.page_size", &page_size) || page_size < 512 || page_size > 65536 ||
      !scalar(db, "PRAGMA main.page_count", &pages) || pages < 1 || (uint64_t)pages > JOURNAL_BYTES / (uint64_t)page_size ||
      !scalar(db, "PRAGMA main.synchronous", &synchronous) || synchronous != 2 ||
      !single_text(db, "SELECT journal_mode FROM pragma_journal_mode", "wal") || !single_text(db, "PRAGMA main.encoding", "UTF-8")) return false;
  row = prepare(db, "SELECT type,name,tbl_name,sql FROM main.sqlite_schema");
  ok = row && sqlite3_step(row) == SQLITE_ROW && text(row, 0, "table") && text(row, 1, "events") &&
    text(row, 2, "events") && text(row, 3, schema) && sqlite3_step(row) == SQLITE_DONE;
  if (sqlite3_finalize(row) != SQLITE_OK) ok = false;
  return ok;
}
static inline bool rows(sqlite3 *db, general_native_replay *replay, lifetime *life) {
  sqlite3_stmt *row = prepare(db, "SELECT sequence,body,digest FROM main.events ORDER BY sequence LIMIT 131073");
  if (!row) return false;
  unsigned count = 0;
  int result;
  bool ok = true;
  while ((result = sqlite3_step(row)) == SQLITE_ROW) {
    if (++count > GENERAL_NATIVE_EVENT_LIMIT || !active(life) || sqlite3_column_type(row, 0) != SQLITE_INTEGER ||
        sqlite3_column_int64(row, 0) != count || sqlite3_column_type(row, 1) != SQLITE_TEXT || sqlite3_column_type(row, 2) != SQLITE_TEXT) { ok = false; break; }
    int size = sqlite3_column_bytes(row, 1), hash_size = sqlite3_column_bytes(row, 2);
    const unsigned char *body = sqlite3_column_text(row, 1), *hash = sqlite3_column_text(row, 2);
    if (size < 1 || size > (int)GENERAL_NATIVE_EVENT_MAX || hash_size != 64 || !body || !hash || memchr(hash, 0, 64)) { ok = false; break; }
    char digest[65]; memcpy(digest, hash, 64); digest[64] = 0;
    if (!general_native_replay_feed(replay, body, (size_t)size, digest) || !active(life)) { ok = false; break; }
  }
  ok = ok && result == SQLITE_DONE;
  if (sqlite3_finalize(row) != SQLITE_OK) ok = false;
  return ok;
}

static inline bool journal_current(void *context) { return active(context); }
/* Fixed snapshot implementation shared by dedicated read-only and retained
 * exclusive connection adapters. Not part of any public entrypoint. */
general_native_replay *general_native_journal_snapshot_private(sqlite3 *db, int read_only, const general_native_head *anchor,
  const general_native_scope_resolver *resolver, bool (*current)(void *), void *context);
#endif
