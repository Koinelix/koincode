#include "native-journal-connection.h"
#include "native-journal-vfs.h"
#include "native-journal-private.h"
#include <stdlib.h>

struct general_native_journal_connection {
  general_native_journal_files *files;
  general_native_journal_vfs *vfs;
  sqlite3 *database;
  bool attempted, ready, closing, uncertain, borrowed;
};
typedef struct { general_native_journal_connection *owner; bool (*current)(void *); void *context; } open_scope;
static bool open_current(void *context) {
  open_scope *scope = context;
  return scope->current(scope->context) && general_native_journal_vfs_current(scope->owner->vfs);
}
general_native_journal_connection *general_native_journal_connection_create(int directory) {
  general_native_journal_connection *owner = calloc(1, sizeof(*owner));
  if (!owner) return NULL;
  owner->files = general_native_journal_files_open(directory);
  if (!owner->files) { free(owner); return NULL; }
  /* A failed file constructor may retain uncertain cleanup ownership. */
  if (!general_native_journal_files_current(owner->files)) { owner->uncertain = true; return owner; }
  owner->vfs = general_native_journal_vfs_create(owner->files);
  return owner;
}
static bool open_connection(general_native_journal_connection *owner, bool (*current)(void *), void *context, bool initializing) {
  if (!owner || owner->attempted || owner->closing || owner->uncertain || !current || !owner->vfs) return false;
  owner->attempted = true;
  open_scope scope = { owner, current, context };
  lifetime life = { .current = open_current, .context = &scope };
  if (clock_gettime(CLOCK_MONOTONIC, &life.started) || !active(&life)) return false;
  int result = sqlite3_open_v2(general_native_journal_vfs_filename(), &owner->database,
    SQLITE_OPEN_READWRITE | SQLITE_OPEN_NOFOLLOW | SQLITE_OPEN_FULLMUTEX | SQLITE_OPEN_PRIVATECACHE,
    general_native_journal_vfs_name(owner->vfs));
  if (result != SQLITE_OK || !active(&life)) return false;
  sqlite3_progress_handler(owner->database, 1000, progress, &life);
  /* Limits must precede even the first configuration SQL and schema load. */
  sqlite3_limit(owner->database, SQLITE_LIMIT_LENGTH, 8192);
  sqlite3_limit(owner->database, SQLITE_LIMIT_SQL_LENGTH, 4096);
  sqlite3_limit(owner->database, SQLITE_LIMIT_COLUMN, 8);
  sqlite3_limit(owner->database, SQLITE_LIMIT_ATTACHED, 0);
  int persist = 1;
  bool ok = sqlite3_busy_timeout(owner->database, 250) == SQLITE_OK &&
    sqlite3_exec(owner->database, "PRAGMA main.locking_mode=EXCLUSIVE", NULL, NULL, NULL) == SQLITE_OK && active(&life) &&
    sqlite3_file_control(owner->database, "main", SQLITE_FCNTL_PERSIST_WAL, &persist) == SQLITE_OK && persist == 1 &&
    configure(owner->database) && active(&life);
  if (ok && initializing) {
    sqlite3_int64 version = -1, objects = -1;
    /* No business data or event is admitted during this private window. Only
     * the exact original schema is created, on the retained empty inodes. */
    ok = scalar(owner->database, "PRAGMA main.user_version", &version) && version == 0 &&
      scalar(owner->database, "SELECT count(*) FROM main.sqlite_schema", &objects) && objects == 0 && active(&life) &&
      sqlite3_exec(owner->database, "PRAGMA main.journal_mode=MEMORY", NULL, NULL, NULL) == SQLITE_OK &&
      single_text(owner->database, "SELECT journal_mode FROM pragma_journal_mode", "memory") && active(&life) &&
      sqlite3_exec(owner->database, "BEGIN EXCLUSIVE", NULL, NULL, NULL) == SQLITE_OK && active(&life) &&
      sqlite3_exec(owner->database, schema, NULL, NULL, NULL) == SQLITE_OK && active(&life) &&
      sqlite3_exec(owner->database, "PRAGMA main.user_version=1", NULL, NULL, NULL) == SQLITE_OK && active(&life) &&
      sqlite3_exec(owner->database, "COMMIT", NULL, NULL, NULL) == SQLITE_OK && active(&life) &&
      sqlite3_exec(owner->database, "PRAGMA main.journal_mode=WAL", NULL, NULL, NULL) == SQLITE_OK && active(&life);
    /* End even after a SQL failure; a failed bootstrap cannot keep MEMORY
     * available to any later code. No rollback, repair or new connection. */
    if (!general_native_journal_vfs_bootstrap_end(owner->vfs)) ok = false;
  }
  ok = ok && metadata(owner->database) && active(&life) &&
    general_native_journal_vfs_matches(owner->vfs, owner->database) && sqlite3_get_autocommit(owner->database) &&
    !sqlite3_next_stmt(owner->database, NULL) && active(&life);
  if (ok && initializing) {
    sqlite3_int64 count = -1;
    ok = scalar(owner->database, "SELECT count(*) FROM main.events", &count) && count == 0 && active(&life);
  }
  sqlite3_progress_handler(owner->database, 0, NULL, NULL);
  owner->ready = ok;
  return ok;
}
bool general_native_journal_connection_open(general_native_journal_connection *owner, bool (*current)(void *), void *context) {
  return open_connection(owner, current, context, false);
}
general_native_journal_initialization general_native_journal_connection_initialize(int directory,
    bool (*current)(void *), void *context, general_native_journal_connection **out) {
  if (!out || *out || !current) return GENERAL_NATIVE_INITIALIZATION_REJECTED;
  lifetime life = { .current = current, .context = context };
  if (clock_gettime(CLOCK_MONOTONIC, &life.started) || !active(&life)) return GENERAL_NATIVE_INITIALIZATION_REJECTED;
  general_native_journal_connection *owner = calloc(1, sizeof(*owner));
  if (!owner) return GENERAL_NATIVE_INITIALIZATION_REJECTED;
  general_native_files_creation result = general_native_journal_files_create(directory, journal_current, &life, &owner->files);
  if (result == GENERAL_NATIVE_FILES_REJECTED || result == GENERAL_NATIVE_FILES_BUSY) {
    free(owner); return result == GENERAL_NATIVE_FILES_BUSY ? GENERAL_NATIVE_INITIALIZATION_BUSY : GENERAL_NATIVE_INITIALIZATION_REJECTED;
  }
  *out = owner;
  if (result == GENERAL_NATIVE_FILES_CREATED) {
    owner->vfs = general_native_journal_vfs_create(owner->files);
    if (owner->vfs && general_native_journal_vfs_bootstrap_begin(owner->vfs) && open_connection(owner, journal_current, &life, true))
      return GENERAL_NATIVE_INITIALIZATION_READY;
    if (owner->vfs) general_native_journal_vfs_bootstrap_end(owner->vfs);
  }
  owner->uncertain = true; owner->ready = false;
  return GENERAL_NATIVE_INITIALIZATION_UNCERTAIN;
}
bool general_native_journal_connection_current(general_native_journal_connection *owner) {
  return owner && owner->ready && !owner->closing && !owner->uncertain && owner->database &&
    general_native_journal_vfs_matches(owner->vfs, owner->database);
}
sqlite3 *general_native_journal_connection_database(general_native_journal_connection *owner) {
  return general_native_journal_connection_current(owner) ? owner->database : NULL;
}
bool general_native_journal_connection_borrow(general_native_journal_connection *owner) {
  if (!general_native_journal_connection_current(owner) || owner->borrowed) return false;
  owner->borrowed = true; return true;
}
bool general_native_journal_connection_return(general_native_journal_connection *owner) {
  if (!owner || !owner->borrowed || owner->uncertain) return false;
  owner->borrowed = false; return true;
}
general_native_connection_close_result general_native_journal_connection_close(general_native_journal_connection **pointer) {
  if (!pointer || !*pointer) return GENERAL_NATIVE_CONNECTION_CLOSED;
  general_native_journal_connection *owner = *pointer;
  if (owner->borrowed) return GENERAL_NATIVE_CONNECTION_BUSY;
  owner->closing = true; owner->ready = false;
  if (owner->uncertain) return GENERAL_NATIVE_CONNECTION_UNCERTAIN;
  if (owner->database) {
    int result = sqlite3_close(owner->database);
    if (result == SQLITE_BUSY) return GENERAL_NATIVE_CONNECTION_BUSY;
    if (result != SQLITE_OK) { owner->uncertain = true; return GENERAL_NATIVE_CONNECTION_UNCERTAIN; }
    owner->database = NULL;
  }
  if (!general_native_journal_vfs_destroy(&owner->vfs) || !general_native_journal_files_close(&owner->files)) {
    owner->uncertain = true; return GENERAL_NATIVE_CONNECTION_UNCERTAIN;
  }
  free(owner); *pointer = NULL;
  return GENERAL_NATIVE_CONNECTION_CLOSED;
}
