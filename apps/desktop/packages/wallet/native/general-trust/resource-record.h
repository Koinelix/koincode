#ifndef KOINCODE_GENERAL_RESOURCE_RECORD_H
#define KOINCODE_GENERAL_RESOURCE_RECORD_H
#include "session-canonical.h"
#include <sys/stat.h>
#define GENERAL_RESOURCE_RECORD_MAX 16384U
typedef struct { uint64_t device, inode; } general_resource_file_identity;
typedef enum { GENERAL_RESOURCE_ORIGIN_NONE, GENERAL_RESOURCE_INITIALIZATION, GENERAL_RESOURCE_RESTORE } general_resource_origin;
typedef enum { GENERAL_RESOURCE_STAGE_NONE, GENERAL_RESOURCE_ADMITTED, GENERAL_RESOURCE_WRITE_STARTED,
  GENERAL_RESOURCE_CREATED, GENERAL_RESOURCE_UNCERTAIN } general_resource_stage;
typedef struct {
  uint32_t uid;
  char owner_id[37], installation_id[37], enrollment_id[37], profile_id[37], creation_id[37];
  general_resource_kind kind;
  general_resource_origin origin;
  char origin_id[37], origin_digest[65];
  general_resource_stage stage;
  general_resource_file_identity parent, directory, database, writer_lease;
  bool has_identities;
  char record_digest[65];
} general_resource_record;
/* Pure approved v1 metadata only. No directory, ticket, authentication, actual
 * origin/active profile, protected prefix, creation, ready or signing evidence.
 * All output arguments stay unchanged on failure. */
bool general_resource_record_digest(const general_resource_record *record, char out[65]);
bool general_resource_record_valid(const general_resource_record *record);
bool general_resource_record_parse(const unsigned char *bytes, size_t size, general_resource_record *out);
bool general_resource_record_encode(const general_resource_record *record, unsigned char *out, size_t capacity, size_t *size);
bool general_resource_record_transition_valid(const general_resource_record *before, const general_resource_record *after);
bool general_resource_reference(general_resource_kind kind, const char *profile, char *out, size_t capacity);
bool general_resource_account(const char *enrollment, general_resource_kind kind, const char *profile, char *out, size_t capacity);
/* Bit-preserving Darwin projection only; performs no fstat or file validation. */
bool general_resource_identity_from_stat(const struct stat *entry, general_resource_file_identity *out);
#endif
