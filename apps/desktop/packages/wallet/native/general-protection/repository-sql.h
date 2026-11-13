#ifndef KOINCODE_GENERAL_REPOSITORY_SQL_H
#define KOINCODE_GENERAL_REPOSITORY_SQL_H
#include "repository-pair.h"
#include <stddef.h>
#ifndef GENERAL_SQL_RESULT_BYTES
#define GENERAL_SQL_RESULT_BYTES (32U * 1024 * 1024)
#endif
#ifndef GENERAL_SQL_VM_STEPS
#define GENERAL_SQL_VM_STEPS UINT64_C(50000000)
#endif
#define GENERAL_SQL_SAFE_INTEGER INT64_C(9007199254740991)
typedef struct general_repository_sql general_repository_sql;
typedef enum {
  GENERAL_SQL_BEGIN, GENERAL_SQL_COMMIT, GENERAL_SQL_ROLLBACK, GENERAL_SQL_STATE_READ, GENERAL_SQL_STATE_WRITE,
  GENERAL_SQL_STREAMS, GENERAL_SQL_EVENTS, GENERAL_SQL_SIZES, GENERAL_SQL_PREVIOUS, GENERAL_SQL_COUNT,
  GENERAL_SQL_APPEND, GENERAL_SQL_VERSION, GENERAL_SQL_RECIPE_COUNT
} general_sql_recipe;
typedef enum { GENERAL_SQL_INTEGER, GENERAL_SQL_TEXT } general_sql_type;
typedef struct { general_sql_type type; int64_t integer; const unsigned char *text; size_t bytes; } general_sql_parameter;
typedef struct { general_sql_type type; int64_t integer; unsigned char *text; size_t bytes; } general_sql_cell;
typedef struct {
  size_t rows, columns; const char *names[3]; general_sql_cell *cells;
  int64_t changes; size_t owned_bytes, allocated_cells;
} general_sql_result;
typedef enum { GENERAL_SQL_REJECTED, GENERAL_SQL_OK, GENERAL_SQL_BUSY, GENERAL_SQL_UNCERTAIN } general_sql_status;
/* Native-private ownership transfer. The original actual resource/session actor
 * establishes admission; a pair, parsed result or recipe is never permission. */
general_repository_sql *general_repository_sql_take(general_repository_pair **pair);
/* Immutable recipe text for the fixed private bridge's exact mapping only.
 * There is deliberately no caller SQL, path/fd or caller-selected kind API. */
const char *general_repository_sql_recipe_text(general_sql_recipe recipe);
general_sql_status general_repository_sql_execute(general_repository_sql *owner, general_sql_recipe recipe,
  const general_sql_parameter *parameters, size_t count, general_sql_result **out);
void general_repository_sql_result_free(general_sql_result **result);
general_repository_close_result general_repository_sql_close(general_repository_sql **owner);
#endif
