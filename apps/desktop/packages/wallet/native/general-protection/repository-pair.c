#include "repository-pair.h"
#include <stdlib.h>
#include <string.h>
#include <time.h>

static const char state_schema[] = "CREATE TABLE general_state(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, state_json TEXT NOT NULL)";
static const char signing_schema[] = "CREATE TABLE signing_events(stream_id TEXT NOT NULL, sequence INTEGER NOT NULL, event_digest TEXT NOT NULL, event_json TEXT NOT NULL, PRIMARY KEY(stream_id,sequence))";
static const char lease_schema[] = "CREATE TABLE writer_guard (id INTEGER PRIMARY KEY)";
struct general_repository_pair {
  general_repository_files *files;
  general_repository_vfs *vfs;
  sqlite3 *main, *lease;
  general_repository_kind kind;
  bool ready, closing, uncertain, borrowed, building, commit_borrowed;
  bool (*current)(void *); void *context;
  struct timespec start, last;
  unsigned ticks;
};
static bool resource_current(void *context) {
  general_repository_pair *owner = context;
  if (!owner->current(owner->context)) return false;
  if (!owner->building) return true;
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) || now.tv_sec < 0 || now.tv_nsec < 0 || now.tv_nsec >= 1000000000 ||
      now.tv_sec < owner->last.tv_sec || (now.tv_sec == owner->last.tv_sec && now.tv_nsec < owner->last.tv_nsec)) return false;
  owner->last = now;
  return now.tv_sec - owner->start.tv_sec < 30 || (now.tv_sec - owner->start.tv_sec == 30 && now.tv_nsec < owner->start.tv_nsec);
}
static int progress(void *context) { general_repository_pair *owner = context; return ++owner->ticks > 50000 || !resource_current(owner); }
static bool text(sqlite3_stmt *row, int column, const char *value) {
  if (sqlite3_column_type(row, column) != SQLITE_TEXT) return false;
  const unsigned char *bytes = sqlite3_column_text(row, column);
  return bytes && sqlite3_column_bytes(row, column) == (int)strlen(value) && !memcmp(bytes, value, strlen(value));
}
static bool scalar(sqlite3 *db, const char *sql, sqlite3_int64 *out) {
  sqlite3_stmt *row = NULL;
  bool ok = sqlite3_prepare_v2(db, sql, -1, &row, NULL) == SQLITE_OK && row && sqlite3_stmt_readonly(row) &&
    sqlite3_step(row) == SQLITE_ROW && sqlite3_column_count(row) == 1 && sqlite3_column_type(row, 0) == SQLITE_INTEGER;
  sqlite3_int64 value = ok ? sqlite3_column_int64(row, 0) : -1;
  ok = ok && sqlite3_step(row) == SQLITE_DONE;
  if (sqlite3_finalize(row) != SQLITE_OK) ok = false;
  if (ok) *out = value; return ok;
}
static bool single_text(sqlite3 *db, const char *sql, const char *value) {
  sqlite3_stmt *row = NULL;
  bool ok = sqlite3_prepare_v2(db, sql, -1, &row, NULL) == SQLITE_OK && row && sqlite3_stmt_readonly(row) &&
    sqlite3_step(row) == SQLITE_ROW && sqlite3_column_count(row) == 1 && text(row, 0, value) && sqlite3_step(row) == SQLITE_DONE;
  if (sqlite3_finalize(row) != SQLITE_OK) ok = false; return ok;
}
static bool execute(general_repository_pair *owner, sqlite3 *db, const char *sql) {
  return resource_current(owner) && general_repository_vfs_current(owner->vfs) &&
    sqlite3_exec(db, sql, NULL, NULL, NULL) == SQLITE_OK && resource_current(owner) && general_repository_vfs_current(owner->vfs);
}
static bool configure(general_repository_pair *owner, sqlite3 *db, bool lease) {
  sqlite3_progress_handler(db, 1000, progress, owner);
  sqlite3_limit(db, SQLITE_LIMIT_LENGTH, lease ? 8192 : owner->kind == GENERAL_REPOSITORY_STATE ? 512 * 1024 + 1024 : 8192 + 1024);
  sqlite3_limit(db, SQLITE_LIMIT_SQL_LENGTH, 4096);
  sqlite3_limit(db, SQLITE_LIMIT_COLUMN, 8);
  sqlite3_limit(db, SQLITE_LIMIT_ATTACHED, 0);
  int setting = -1, persist = 1;
  return sqlite3_db_config(db, SQLITE_DBCONFIG_DEFENSIVE, 1, &setting) == SQLITE_OK && setting == 1 &&
    sqlite3_db_config(db, SQLITE_DBCONFIG_TRUSTED_SCHEMA, 0, &setting) == SQLITE_OK && setting == 0 &&
    sqlite3_busy_timeout(db, lease ? 0 : 250) == SQLITE_OK &&
    execute(owner, db, "PRAGMA main.locking_mode=EXCLUSIVE") && execute(owner, db, "PRAGMA main.synchronous=FULL") &&
    execute(owner, db, "PRAGMA temp_store=MEMORY") && execute(owner, db, "PRAGMA main.mmap_size=0") &&
    sqlite3_file_control(db, "main", SQLITE_FCNTL_PERSIST_WAL, &persist) == SQLITE_OK && persist == 1;
}
static bool schema(sqlite3 *db, general_repository_kind kind, bool lease) {
  sqlite3_stmt *row = NULL;
  bool ok = sqlite3_prepare_v2(db, "SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name", -1, &row, NULL) == SQLITE_OK && row;
  if (ok && !lease && kind == GENERAL_REPOSITORY_SIGNING)
    ok = sqlite3_step(row) == SQLITE_ROW && text(row, 0, "index") && text(row, 1, "sqlite_autoindex_signing_events_1") &&
      text(row, 2, "signing_events") && sqlite3_column_type(row, 3) == SQLITE_NULL;
  const char *name = lease ? "writer_guard" : kind == GENERAL_REPOSITORY_STATE ? "general_state" : "signing_events";
  const char *sql = lease ? lease_schema : kind == GENERAL_REPOSITORY_STATE ? state_schema : signing_schema;
  ok = ok && sqlite3_step(row) == SQLITE_ROW && text(row, 0, "table") && text(row, 1, name) && text(row, 2, name) && text(row, 3, sql) && sqlite3_step(row) == SQLITE_DONE;
  if (sqlite3_finalize(row) != SQLITE_OK) ok = false; return ok;
}
static bool metadata(general_repository_pair *owner, sqlite3 *db, bool lease) {
  sqlite3_int64 version = -1, synchronous = -1, pages = -1, page_size = -1;
  sqlite3_stmt *row = NULL;
  bool ok = sqlite3_prepare_v2(db, "PRAGMA database_list", -1, &row, NULL) == SQLITE_OK && row &&
    sqlite3_step(row) == SQLITE_ROW && text(row, 1, "main") && sqlite3_step(row) == SQLITE_DONE;
  if (sqlite3_finalize(row) != SQLITE_OK) ok = false;
  return ok && scalar(db, "PRAGMA main.user_version", &version) && version == (lease ? 0 : 1) &&
    scalar(db, "PRAGMA main.synchronous", &synchronous) && synchronous == 2 &&
    scalar(db, "PRAGMA main.page_count", &pages) && pages > 0 && scalar(db, "PRAGMA main.page_size", &page_size) &&
    page_size >= 512 && page_size <= 65536 && (uint64_t)pages <= GENERAL_REPOSITORY_BYTES / (uint64_t)page_size &&
    single_text(db, "PRAGMA main.encoding", "UTF-8") && single_text(db, "SELECT journal_mode FROM pragma_journal_mode", lease ? "memory" : "wal") &&
    single_text(db, "PRAGMA main.locking_mode", "exclusive") && schema(db, owner->kind, lease) && resource_current(owner) &&
    general_repository_vfs_matches(owner->vfs, db, lease);
}
static bool open_database(general_repository_pair *owner, bool lease, bool create) {
  sqlite3 **db = lease ? &owner->lease : &owner->main;
  int result = sqlite3_open_v2(general_repository_vfs_filename(owner->vfs, lease), db,
    SQLITE_OPEN_READWRITE | SQLITE_OPEN_NOFOLLOW | SQLITE_OPEN_FULLMUTEX | SQLITE_OPEN_PRIVATECACHE, general_repository_vfs_name(owner->vfs));
  if (result != SQLITE_OK || !resource_current(owner) || !configure(owner, *db, lease)) return false;
  if (create) {
    sqlite3_int64 version = -1, objects = -1;
    const char *sql = lease ? lease_schema : owner->kind == GENERAL_REPOSITORY_STATE ? state_schema : signing_schema;
    if (!scalar(*db, "PRAGMA main.user_version", &version) || version != 0 ||
        !scalar(*db, "SELECT count(*) FROM main.sqlite_schema", &objects) || objects != 0 ||
        !execute(owner, *db, "PRAGMA main.journal_mode=MEMORY") || !execute(owner, *db, "BEGIN EXCLUSIVE") ||
        !execute(owner, *db, sql) || (!lease && !execute(owner, *db, "PRAGMA main.user_version=1")) ||
        !execute(owner, *db, "COMMIT")) return false;
  }
  if (lease) {
    if (!execute(owner, *db, "PRAGMA main.journal_mode=MEMORY") || !metadata(owner, *db, true) ||
        !execute(owner, *db, "BEGIN EXCLUSIVE")) return false;
  } else {
    if (create && !execute(owner, *db, "PRAGMA main.journal_mode=WAL")) return false;
    if (!metadata(owner, *db, false)) return false;
  }
  return !sqlite3_next_stmt(*db, NULL) && (lease ? !sqlite3_get_autocommit(*db) : sqlite3_get_autocommit(*db)) && resource_current(owner);
}
general_repository_open_result general_repository_pair_open(int directory, general_repository_kind kind, bool create,
    bool (*current)(void *), void *context, general_repository_pair **out) {
  if (!current || !out || *out || kind < GENERAL_REPOSITORY_STATE || kind > GENERAL_REPOSITORY_SIGNING) return GENERAL_REPOSITORY_REJECTED;
  general_repository_pair *owner = calloc(1, sizeof(*owner));
  if (!owner) return GENERAL_REPOSITORY_REJECTED;
  owner->kind = kind; owner->current = current; owner->context = context; owner->building = true;
  if (clock_gettime(CLOCK_MONOTONIC, &owner->start)) { free(owner); return GENERAL_REPOSITORY_REJECTED; }
  owner->last = owner->start;
  general_repository_open_result files = general_repository_files_open(directory, kind, create, resource_current, owner, &owner->files);
  if (files == GENERAL_REPOSITORY_REJECTED) { free(owner); return files; }
  bool ok = files == GENERAL_REPOSITORY_READY;
  if (ok) { owner->vfs = general_repository_vfs_create(owner->files); ok = owner->vfs != NULL; }
  if (ok && create) ok = general_repository_vfs_bootstrap_begin(owner->vfs);
  ok = ok && open_database(owner, true, create) && open_database(owner, false, create);
  if (create && owner->vfs && !general_repository_vfs_bootstrap_end(owner->vfs)) ok = false;
  if (owner->main) sqlite3_progress_handler(owner->main, 0, NULL, NULL);
  if (owner->lease) sqlite3_progress_handler(owner->lease, 0, NULL, NULL);
  ok = ok && resource_current(owner) && general_repository_vfs_matches(owner->vfs, owner->main, false) &&
    general_repository_vfs_matches(owner->vfs, owner->lease, true);
  owner->building = false; owner->ready = ok;
  if (ok) { *out = owner; return GENERAL_REPOSITORY_READY; }
  if (create || files == GENERAL_REPOSITORY_UNCERTAIN) { owner->uncertain = true; *out = owner; return GENERAL_REPOSITORY_UNCERTAIN; }
  if (general_repository_pair_close(&owner) == GENERAL_PAIR_CLOSED) return GENERAL_REPOSITORY_REJECTED;
  *out = owner; return GENERAL_REPOSITORY_UNCERTAIN;
}
bool general_repository_pair_current(general_repository_pair *owner) {
  if (!owner || !owner->ready || owner->closing || owner->uncertain) return false;
  bool valid = general_repository_vfs_matches(owner->vfs, owner->main, false) && general_repository_vfs_matches(owner->vfs, owner->lease, true) &&
    !sqlite3_get_autocommit(owner->lease);
  if (!valid) owner->ready = false; return valid;
}
bool general_repository_pair_resources_current(general_repository_pair *owner) {
  if (!owner || !owner->ready || owner->closing || owner->uncertain) return false;
  bool valid = general_repository_vfs_current(owner->vfs);
  if (!valid) owner->ready = false; return valid;
}
bool general_repository_pair_kind(general_repository_pair *owner, general_repository_kind *kind) {
  if (!kind || !general_repository_pair_current(owner)) return false; *kind = owner->kind; return true;
}
bool general_repository_pair_borrow(general_repository_pair *owner) {
  if (!general_repository_pair_current(owner) || owner->borrowed) return false;
  owner->borrowed = true; return true;
}
bool general_repository_pair_return(general_repository_pair *owner) {
  if (!owner || !owner->borrowed) return false; owner->borrowed = owner->commit_borrowed = false; return true;
}
bool general_repository_pair_commit_borrow(general_repository_pair *owner, int *database, int *writer_lease) {
  if (!database || !writer_lease || !general_repository_pair_current(owner) || owner->borrowed || !sqlite3_get_autocommit(owner->main) ||
      sqlite3_next_stmt(owner->main, NULL) || sqlite3_next_stmt(owner->lease, NULL)) return false;
  int db, lease;
  if (!general_repository_vfs_commit_descriptors(owner->vfs, &db, &lease)) return false;
  owner->borrowed = owner->commit_borrowed = true; *database = db; *writer_lease = lease; return true;
}
sqlite3 *general_repository_pair_database(general_repository_pair *owner) {
  return owner && owner->borrowed && !owner->commit_borrowed && general_repository_pair_current(owner) ? owner->main : NULL;
}
general_repository_close_result general_repository_pair_close(general_repository_pair **pointer) {
  if (!pointer || !*pointer) return GENERAL_PAIR_CLOSED;
  general_repository_pair *owner = *pointer;
  owner->closing = true; owner->ready = false;
  if (owner->uncertain || general_repository_vfs_close_uncertain(owner->vfs)) return GENERAL_PAIR_CLOSE_UNCERTAIN;
  if (owner->borrowed || (owner->main && sqlite3_next_stmt(owner->main, NULL)) || (owner->lease && sqlite3_next_stmt(owner->lease, NULL))) return GENERAL_PAIR_BUSY;
  sqlite3 **connections[] = { &owner->main, &owner->lease };
  for (unsigned i = 0; i < 2; i++) if (*connections[i]) {
    int result = sqlite3_close(*connections[i]);
    if (result == SQLITE_BUSY) return GENERAL_PAIR_BUSY;
    if (result != SQLITE_OK || general_repository_vfs_close_uncertain(owner->vfs)) { owner->uncertain = true; return GENERAL_PAIR_CLOSE_UNCERTAIN; }
    *connections[i] = NULL;
  }
  if (!general_repository_vfs_destroy(&owner->vfs) || !general_repository_files_close(&owner->files)) {
    owner->uncertain = true; return GENERAL_PAIR_CLOSE_UNCERTAIN;
  }
  free(owner); *pointer = NULL; return GENERAL_PAIR_CLOSED;
}
