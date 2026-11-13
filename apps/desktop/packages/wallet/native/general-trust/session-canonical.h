#ifndef KOINCODE_GENERAL_SESSION_CANONICAL_H
#define KOINCODE_GENERAL_SESSION_CANONICAL_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define GENERAL_SESSION_REFERENCE_MAX 96U
#define GENERAL_SESSION_SAFE_INTEGER_MAX UINT64_C(9007199254740991)
typedef struct { const unsigned char *bytes; size_t size, position; } general_canonical_reader;

/* Private fixed-schema parsing primitives; no scope, persistence or authentication authority. */
bool general_canonical_take(general_canonical_reader *reader, const char *value);
bool general_canonical_string(general_canonical_reader *reader, char *out, size_t capacity);
bool general_canonical_integer(general_canonical_reader *reader, uint64_t *out);
bool general_session_uuid_valid(const char *value);
bool general_canonical_hash_valid(const char *value);
bool general_canonical_reference_valid(const char *value);
/* Internal native journal only; never accepted by ordinary read/write. */
typedef enum { GENERAL_RESOURCE_KIND_NONE, GENERAL_RESOURCE_PROFILES_ROOT, GENERAL_RESOURCE_PROFILE_DIRECTORY,
  GENERAL_RESOURCE_HISTORY_DIRECTORY, GENERAL_RESOURCE_STATE_REPOSITORY, GENERAL_RESOURCE_SIGNING_REPOSITORY } general_resource_kind;
const char *general_resource_kind_name(general_resource_kind kind);
general_resource_kind general_resource_kind_parse(const char *name);
bool general_canonical_resource_reference(const char *value, general_resource_kind *kind, char profile[37]);
bool general_canonical_native_reference_valid(const char *value);
#endif
