#include "repository-sql.h"
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

typedef struct { const char *sql; int kind; unsigned parameters, columns, rows; const char *names[3]; } recipe_definition;
static const recipe_definition recipes[] = {
  { "BEGIN IMMEDIATE", -1, 0, 0, 0, { NULL } },
  { "COMMIT", -1, 0, 0, 0, { NULL } },
  { "ROLLBACK", -1, 0, 0, 0, { NULL } },
  { "SELECT revision, state_json FROM main.general_state WHERE id=1", GENERAL_REPOSITORY_STATE, 0, 2, 1, { "revision", "state_json" } },
  { "INSERT INTO main.general_state(id,revision,state_json) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,state_json=excluded.state_json", GENERAL_REPOSITORY_STATE, 2, 0, 0, { NULL } },
  { "SELECT DISTINCT stream_id FROM main.signing_events LIMIT 3585", GENERAL_REPOSITORY_SIGNING, 0, 1, 3585, { "stream_id" } },
  { "SELECT sequence, event_digest, event_json FROM main.signing_events WHERE stream_id=? ORDER BY sequence LIMIT ?", GENERAL_REPOSITORY_SIGNING, 2, 3, 2001, { "sequence", "event_digest", "event_json" } },
  { "SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(event_json AS BLOB))),0) AS bytes FROM main.signing_events", GENERAL_REPOSITORY_SIGNING, 0, 2, 1, { "count", "bytes" } },
  { "SELECT sequence,event_digest FROM main.signing_events WHERE stream_id=? ORDER BY sequence DESC LIMIT 1", GENERAL_REPOSITORY_SIGNING, 1, 2, 1, { "sequence", "event_digest" } },
  { "SELECT count(*) AS n FROM main.signing_events", GENERAL_REPOSITORY_SIGNING, 0, 1, 1, { "n" } },
  { "INSERT INTO main.signing_events(stream_id,sequence,event_digest,event_json) VALUES(?,?,?,?)", GENERAL_REPOSITORY_SIGNING, 4, 0, 0, { NULL } },
  { "PRAGMA user_version", -1, 0, 1, 1, { "user_version" } }
};
_Static_assert(sizeof(recipes) / sizeof(recipes[0]) == GENERAL_SQL_RECIPE_COUNT && GENERAL_SQL_RECIPE_COUNT <= 32, "Bounded original recipes");
struct general_repository_sql {
  general_repository_pair *pair; sqlite3 *db; general_repository_kind kind;
  atomic_flag operation; atomic_bool closing;
  bool executing, loaned, transaction, fenced, uncertain;
  general_sql_recipe recipe;
  struct timespec start, last; unsigned ticks; uint64_t vm_steps;
};
static bool valid_recipe(general_sql_recipe recipe) { return recipe >= GENERAL_SQL_BEGIN && recipe < GENERAL_SQL_RECIPE_COUNT; }
const char *general_repository_sql_recipe_text(general_sql_recipe recipe) { return valid_recipe(recipe) ? recipes[recipe].sql : NULL; }
static bool equal(const char *a, const char *b) { return a && b && sqlite3_stricmp(a, b) == 0; }
static bool write_recipe(general_sql_recipe recipe) { return recipe <= GENERAL_SQL_ROLLBACK || recipe == GENERAL_SQL_STATE_WRITE || recipe == GENERAL_SQL_APPEND; }
static int authorize(void *context, int action, const char *first, const char *second, const char *database, const char *source) {
  general_repository_sql *owner = context;
  if (!owner || !owner->executing || owner->fenced || owner->uncertain || atomic_load(&owner->closing) || source) return SQLITE_DENY;
  general_sql_recipe recipe = owner->recipe;
  if (action == SQLITE_SELECT) return recipes[recipe].columns && recipe != GENERAL_SQL_VERSION ? SQLITE_OK : SQLITE_DENY;
  if (action == SQLITE_PRAGMA) return recipe == GENERAL_SQL_VERSION && equal(first, "user_version") && !second && (!database || equal(database, "main")) ? SQLITE_OK : SQLITE_DENY;
  if (action == SQLITE_TRANSACTION) {
    const char *command = recipe == GENERAL_SQL_BEGIN ? "BEGIN" : recipe == GENERAL_SQL_COMMIT ? "COMMIT" : recipe == GENERAL_SQL_ROLLBACK ? "ROLLBACK" : "";
    return equal(first, command) ? SQLITE_OK : SQLITE_DENY;
  }
  if (action == SQLITE_FUNCTION) {
    if ((recipe == GENERAL_SQL_COUNT || recipe == GENERAL_SQL_SIZES) && equal(second, "count")) return SQLITE_OK;
    return recipe == GENERAL_SQL_SIZES && (equal(second, "coalesce") || equal(second, "sum") || equal(second, "length")) ? SQLITE_OK : SQLITE_DENY;
  }
  const char *table = owner->kind == GENERAL_REPOSITORY_STATE ? "general_state" : "signing_events";
  /* SQLite emits a NULL database for the empty-column COUNT(*) read. Every
   * fixed recipe names main explicitly; no caller SQL or attachment exists. */
  bool count_read = action == SQLITE_READ && second && !second[0] && !database &&
    (recipe == GENERAL_SQL_COUNT || recipe == GENERAL_SQL_SIZES);
  if ((!equal(database, "main") && !count_read) || !equal(first, table)) return SQLITE_DENY;
  if (action == SQLITE_INSERT) return recipe == GENERAL_SQL_STATE_WRITE || recipe == GENERAL_SQL_APPEND ? SQLITE_OK : SQLITE_DENY;
  if (action == SQLITE_UPDATE) return recipe == GENERAL_SQL_STATE_WRITE && (equal(second, "revision") || equal(second, "state_json")) ? SQLITE_OK : SQLITE_DENY;
  if (action == SQLITE_READ && second && ((recipes[recipe].columns && recipe != GENERAL_SQL_VERSION) || recipe == GENERAL_SQL_STATE_WRITE)) {
    if (!second[0]) return SQLITE_OK;
    if (owner->kind == GENERAL_REPOSITORY_STATE)
      return equal(second, "id") || equal(second, "revision") || equal(second, "state_json") ? SQLITE_OK : SQLITE_DENY;
    return equal(second, "stream_id") || equal(second, "sequence") || equal(second, "event_digest") || equal(second, "event_json") ? SQLITE_OK : SQLITE_DENY;
  }
  return SQLITE_DENY;
}
static bool active(general_repository_sql *owner) {
  struct timespec now;
  if (atomic_load(&owner->closing) || owner->fenced || owner->uncertain || !general_repository_pair_resources_current(owner->pair) ||
      clock_gettime(CLOCK_MONOTONIC, &now) || now.tv_sec < 0 || now.tv_nsec < 0 || now.tv_nsec >= 1000000000 ||
      now.tv_sec < owner->last.tv_sec || (now.tv_sec == owner->last.tv_sec && now.tv_nsec < owner->last.tv_nsec)) return false;
  owner->last = now;
  return now.tv_sec - owner->start.tv_sec < 30 || (now.tv_sec - owner->start.tv_sec == 30 && now.tv_nsec < owner->start.tv_nsec);
}
static int progress(void *context) {
  general_repository_sql *owner = context;
  if (!owner->executing || atomic_load(&owner->closing) || ++owner->vm_steps >= GENERAL_SQL_VM_STEPS) return 1;
  if (++owner->ticks < 1000) return 0;
  owner->ticks = 0; return !active(owner);
}
static bool utf8(const unsigned char *bytes, size_t size) {
  if (!bytes || !size || memchr(bytes, 0, size)) return false;
  for (size_t i = 0; i < size;) {
    unsigned c = bytes[i++], code, rest, minimum;
    if (c < 0x80) continue;
    if (c >= 0xc2 && c <= 0xdf) { code = c & 31; rest = 1; minimum = 0x80; }
    else if (c >= 0xe0 && c <= 0xef) { code = c & 15; rest = 2; minimum = 0x800; }
    else if (c >= 0xf0 && c <= 0xf4) { code = c & 7; rest = 3; minimum = 0x10000; }
    else return false;
    if (rest > size - i) return false;
    while (rest--) { unsigned next = bytes[i++]; if ((next & 0xc0) != 0x80) return false; code = (code << 6) | (next & 63); }
    if (code < minimum || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return false;
  }
  return true;
}
static bool hex(const unsigned char *bytes, size_t size) {
  if (!bytes || size != 64) return false;
  for (unsigned i = 0; i < 64; i++) if (!((bytes[i] >= '0' && bytes[i] <= '9') || (bytes[i] >= 'a' && bytes[i] <= 'f'))) return false;
  return true;
}
static bool integer_parameter(const general_sql_parameter *parameter, int64_t minimum, int64_t maximum) {
  return parameter->type == GENERAL_SQL_INTEGER && parameter->integer >= minimum && parameter->integer <= maximum && !parameter->text && !parameter->bytes;
}
static bool text_parameter(const general_sql_parameter *parameter, size_t maximum, bool digest) {
  return parameter->type == GENERAL_SQL_TEXT && !parameter->integer && parameter->bytes <= maximum &&
    (digest ? hex(parameter->text, parameter->bytes) : utf8(parameter->text, parameter->bytes));
}
static bool parameters_valid(general_sql_recipe recipe, const general_sql_parameter *parameters, size_t count) {
  if (count != recipes[recipe].parameters || (count && !parameters)) return false;
  if (recipe == GENERAL_SQL_STATE_WRITE) return integer_parameter(&parameters[0], 0, GENERAL_SQL_SAFE_INTEGER) && text_parameter(&parameters[1], 512 * 1024, false);
  if (recipe == GENERAL_SQL_EVENTS) return text_parameter(&parameters[0], 64, true) && integer_parameter(&parameters[1], 1, 2001);
  if (recipe == GENERAL_SQL_PREVIOUS) return text_parameter(&parameters[0], 64, true);
  if (recipe == GENERAL_SQL_APPEND) return text_parameter(&parameters[0], 64, true) && integer_parameter(&parameters[1], 1, GENERAL_SQL_SAFE_INTEGER) &&
    text_parameter(&parameters[2], 64, true) && text_parameter(&parameters[3], 8192, false);
  return count == 0;
}
static void erase(void *value, size_t size) { volatile unsigned char *bytes = value; while (size--) *bytes++ = 0; }
void general_repository_sql_result_free(general_sql_result **pointer) {
  if (!pointer || !*pointer) return; general_sql_result *result = *pointer;
  for (size_t i = 0; i < result->rows * result->columns; i++) if (result->cells[i].text) {
    erase(result->cells[i].text, result->cells[i].bytes + 1); free(result->cells[i].text);
  }
  if (result->cells) { erase(result->cells, result->allocated_cells * sizeof(*result->cells)); free(result->cells); }
  erase(result, sizeof(*result)); free(result); *pointer = NULL;
}
static bool collect(general_repository_sql *owner, sqlite3_stmt *statement, general_sql_result *result) {
  const recipe_definition *recipe = &recipes[owner->recipe];
  if (result->rows >= recipe->rows || result->columns != (size_t)sqlite3_column_count(statement)) return false;
  general_sql_cell *row = result->cells + result->rows * result->columns;
  result->rows++;
  for (size_t i = 0; i < result->columns; i++) {
    const char *name = recipe->names[i]; bool is_text = !strcmp(name, "state_json") || !strcmp(name, "stream_id") || !strcmp(name, "event_digest") || !strcmp(name, "event_json");
    if (!is_text) {
      if (sqlite3_column_type(statement, (int)i) != SQLITE_INTEGER) return false;
      int64_t integer = sqlite3_column_int64(statement, (int)i);
      if (integer < -GENERAL_SQL_SAFE_INTEGER || integer > GENERAL_SQL_SAFE_INTEGER) return false;
      row[i].type = GENERAL_SQL_INTEGER; row[i].integer = integer;
    } else {
      if (sqlite3_column_type(statement, (int)i) != SQLITE_TEXT) return false;
      int size = sqlite3_column_bytes(statement, (int)i); const unsigned char *text = sqlite3_column_text(statement, (int)i);
      size_t limit = !strcmp(name, "state_json") ? 512 * 1024 : !strcmp(name, "event_json") ? 8192 : 64;
      if (size < 1 || (size_t)size > limit || !utf8(text, (size_t)size) || (size_t)size + 1 > GENERAL_SQL_RESULT_BYTES - result->owned_bytes) return false;
      row[i].text = malloc((size_t)size + 1); if (!row[i].text) return false;
      memcpy(row[i].text, text, (size_t)size); row[i].text[size] = 0; row[i].bytes = (size_t)size; row[i].type = GENERAL_SQL_TEXT;
      result->owned_bytes += (size_t)size + 1;
    }
  }
  return true;
}
general_repository_sql *general_repository_sql_take(general_repository_pair **pointer) {
  if (!pointer || !*pointer) return NULL;
  general_repository_kind kind;
  if (!general_repository_pair_kind(*pointer, &kind) || !general_repository_pair_borrow(*pointer)) return NULL;
  sqlite3 *db = general_repository_pair_database(*pointer);
  if (!db || !sqlite3_get_autocommit(db) || sqlite3_next_stmt(db, NULL)) { general_repository_pair_return(*pointer); return NULL; }
  general_repository_sql *owner = calloc(1, sizeof(*owner));
  if (!owner) { general_repository_pair_return(*pointer); return NULL; }
  owner->pair = *pointer; owner->db = db; owner->kind = kind; owner->loaned = true;
  atomic_flag_clear(&owner->operation); atomic_init(&owner->closing, false);
  if (sqlite3_set_authorizer(db, authorize, owner) != SQLITE_OK) { general_repository_pair_return(*pointer); erase(owner, sizeof(*owner)); free(owner); return NULL; }
  sqlite3_progress_handler(db, 1, progress, owner);
  *pointer = NULL; return owner;
}
general_sql_status general_repository_sql_execute(general_repository_sql *owner, general_sql_recipe recipe,
    const general_sql_parameter *parameters, size_t count, general_sql_result **out) {
  if (!owner || !out || *out || !valid_recipe(recipe)) return GENERAL_SQL_REJECTED;
  if (atomic_flag_test_and_set(&owner->operation)) return GENERAL_SQL_BUSY;
  general_sql_status status = GENERAL_SQL_REJECTED;
  sqlite3_stmt *statement = NULL; general_sql_result *result = NULL;
  bool stepped = false, failed = false; int code = SQLITE_OK;
  if (owner->uncertain) { status = GENERAL_SQL_UNCERTAIN; goto done; }
  if (owner->fenced || atomic_load(&owner->closing) || (recipes[recipe].kind >= 0 && recipes[recipe].kind != (int)owner->kind) || !parameters_valid(recipe, parameters, count)) goto done;
  if ((recipe == GENERAL_SQL_BEGIN && owner->transaction) || ((recipe == GENERAL_SQL_COMMIT || recipe == GENERAL_SQL_ROLLBACK || recipe == GENERAL_SQL_STATE_WRITE || recipe == GENERAL_SQL_APPEND) && !owner->transaction)) goto done;
  if (!owner->transaction) {
    if (clock_gettime(CLOCK_MONOTONIC, &owner->start) || owner->start.tv_sec < 0 || owner->start.tv_nsec < 0 || owner->start.tv_nsec >= 1000000000) { owner->fenced = true; goto done; }
    owner->last = owner->start; owner->ticks = 0; owner->vm_steps = 0;
  }
  if (!active(owner) || !general_repository_pair_current(owner->pair) || sqlite3_next_stmt(owner->db, NULL) || !!sqlite3_get_autocommit(owner->db) == owner->transaction) { failed = true; goto finish; }
  owner->recipe = recipe; owner->executing = true;
  const char *tail = NULL;
  code = sqlite3_prepare_v2(owner->db, recipes[recipe].sql, -1, &statement, &tail);
  if (code != SQLITE_OK || !statement || !tail || *tail || sqlite3_bind_parameter_count(statement) != (int)count ||
      (sqlite3_stmt_readonly(statement) == 0) != (recipe == GENERAL_SQL_BEGIN || recipe == GENERAL_SQL_STATE_WRITE || recipe == GENERAL_SQL_APPEND)) { failed = true; goto finish; }
  for (unsigned i = 0; i < count; i++) {
    code = parameters[i].type == GENERAL_SQL_INTEGER ? sqlite3_bind_int64(statement, (int)i + 1, parameters[i].integer) :
      sqlite3_bind_text64(statement, (int)i + 1, (const char *)parameters[i].text, parameters[i].bytes, SQLITE_STATIC, SQLITE_UTF8);
    if (code != SQLITE_OK) { failed = true; goto finish; }
  }
  result = calloc(1, sizeof(*result));
  if (!result) { failed = true; goto finish; }
  result->columns = recipes[recipe].columns; result->allocated_cells = recipes[recipe].rows * result->columns;
  result->owned_bytes = sizeof(*result) + result->allocated_cells * sizeof(*result->cells);
  if (result->owned_bytes > GENERAL_SQL_RESULT_BYTES) { failed = true; goto finish; }
  if (result->allocated_cells) {
    result->cells = calloc(result->allocated_cells, sizeof(*result->cells));
    if (!result->cells) { failed = true; goto finish; }
  }
  for (unsigned i = 0; i < result->columns; i++) result->names[i] = recipes[recipe].names[i];
  if (!active(owner)) { failed = true; goto finish; }
  stepped = true;
  while ((code = sqlite3_step(statement)) == SQLITE_ROW) {
    if (!active(owner) || !collect(owner, statement, result)) { failed = true; break; }
  }
  if (code != SQLITE_DONE) failed = true;
finish:
  if (statement) { int finalized = sqlite3_finalize(statement); statement = NULL; if (finalized != SQLITE_OK) { if (code == SQLITE_DONE || code == SQLITE_OK) code = finalized; failed = true; } }
  bool current = active(owner) && general_repository_pair_current(owner->pair) && !sqlite3_next_stmt(owner->db, NULL);
  bool expected_transaction = !failed && recipe == GENERAL_SQL_BEGIN ? true : !failed && (recipe == GENERAL_SQL_COMMIT || recipe == GENERAL_SQL_ROLLBACK) ? false : owner->transaction;
  bool matching_transaction = !!sqlite3_get_autocommit(owner->db) != expected_transaction;
  if (failed || !current || !matching_transaction) {
    bool known = current && matching_transaction && ((code & 255) == SQLITE_BUSY || (code & 255) == SQLITE_CONSTRAINT);
    if (!known) {
      owner->fenced = true;
      owner->uncertain = owner->transaction || (stepped && write_recipe(recipe));
    }
    if (owner->uncertain) status = GENERAL_SQL_UNCERTAIN;
    goto done;
  }
  if (result->columns == 0) {
    result->changes = sqlite3_changes64(owner->db);
    if (result->changes < 0 || result->changes > GENERAL_SQL_SAFE_INTEGER) { owner->fenced = owner->uncertain = true; status = GENERAL_SQL_UNCERTAIN; goto done; }
  }
  owner->transaction = expected_transaction;
  *out = result; result = NULL; status = GENERAL_SQL_OK;
done:
  general_repository_sql_result_free(&result); owner->executing = false;
  atomic_flag_clear(&owner->operation); return status;
}
general_repository_close_result general_repository_sql_close(general_repository_sql **pointer) {
  if (!pointer || !*pointer) return GENERAL_PAIR_CLOSED;
  general_repository_sql *owner = *pointer; atomic_store(&owner->closing, true);
  if (atomic_flag_test_and_set(&owner->operation)) return GENERAL_PAIR_BUSY;
  general_repository_close_result result = GENERAL_PAIR_CLOSE_UNCERTAIN;
  if (owner->uncertain) goto retained;
  if (owner->loaned) { if (!general_repository_pair_return(owner->pair)) { owner->uncertain = true; goto retained; } owner->loaned = false; }
  result = general_repository_pair_close(&owner->pair);
  if (result == GENERAL_PAIR_CLOSE_UNCERTAIN) owner->uncertain = true;
  if (result == GENERAL_PAIR_CLOSED) { erase(owner, sizeof(*owner)); free(owner); *pointer = NULL; return result; }
retained:
  atomic_flag_clear(&owner->operation); return result;
}
