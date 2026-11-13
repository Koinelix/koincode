#ifndef KOINCODE_GENERAL_DOMAIN_BINDING_H
#define KOINCODE_GENERAL_DOMAIN_BINDING_H
#include "assignment.h"
#include "initialization.h"
#define GENERAL_DOMAIN_BINDING_MAX 16384U

typedef enum { GENERAL_BINDING_ORIGIN_NONE, GENERAL_BINDING_NEW, GENERAL_BINDING_RESTORE } general_binding_origin;
typedef enum { GENERAL_BINDING_SIGNING_NONE, GENERAL_BINDING_LIVE, GENERAL_BINDING_ARCHIVE_ONLY } general_binding_signing;
typedef struct {
  uint32_t uid;
  uint64_t revision;
  char enrollment_id[37], installation_id[37], owner_id[37], profile_id[37], binding_digest[65];
  bool has_previous;
  char previous_binding_digest[65];
  general_binding_origin origin;
  union {
    struct { char initialization_id[37], initialization_digest[65]; } created;
    struct { char recovery_id[37], plan_digest[65], archive_digest[65], artifact_id[37], archive_ciphertext_digest[65]; } restored;
  } source;
  general_binding_signing signing;
  char domain_id[37];
} general_domain_binding;

/* Private pure format checks only. No IO, active view, provenance, restore
 * continuity, publication or signing authority follows from these structs. */
bool general_domain_binding_valid(const general_domain_binding *binding);
/* Deterministic initial-new metadata only, not freshness or publication. */
bool general_domain_binding_initial(const general_initialization_record *initialization, general_domain_binding *out);
/* Failure leaves outputs unchanged. Only the existing canonical v1 is accepted. */
bool general_domain_binding_parse(const unsigned char *bytes, size_t size, general_domain_binding *out);
bool general_domain_binding_encode(const general_domain_binding *binding, unsigned char *out, size_t capacity, size_t *size);
/* Provided-record association only. Actual actor must independently establish
 * protected sources, current stage/prefix, target resources and genuine scope.
 * This helper does not handle restore-plan association or perform publication. */
bool general_domain_binding_new_valid(const general_domain_binding *binding, const general_assignment *assignment,
  const general_initialization_record *initialization);
#endif
