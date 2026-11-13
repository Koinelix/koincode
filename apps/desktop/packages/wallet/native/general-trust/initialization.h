#ifndef KOINCODE_GENERAL_NATIVE_INITIALIZATION_H
#define KOINCODE_GENERAL_NATIVE_INITIALIZATION_H
#include "native-head.h"
#define GENERAL_NATIVE_INITIALIZATION_MAX 16384U

typedef enum { GENERAL_INITIALIZATION_KIND_NONE, GENERAL_INITIALIZATION_NEW, GENERAL_INITIALIZATION_RESTORE } general_initialization_kind;
typedef enum { GENERAL_INITIALIZATION_PHASE_NONE, GENERAL_INITIALIZATION_PREPARED, GENERAL_INITIALIZATION_STATE_PUBLISHED,
  GENERAL_INITIALIZATION_JOURNAL_PUBLISHED, GENERAL_INITIALIZATION_READY } general_initialization_phase;
typedef struct {
  general_native_identity identity;
  general_initialization_kind kind;
  char target_state_commitment[65], initial_signing_domain_id[37];
  bool has_recovery;
  char recovery_plan_digest[65];
} general_initialization_plan;
typedef struct {
  general_native_identity identity;
  general_initialization_kind kind;
  general_initialization_phase phase;
  char target_state_commitment[65], initial_signing_domain_id[37];
} general_initialization_record;

/* Fixed metadata and digest relationship only. Actual actor owns authenticated
 * restore/state facts, peer, original plan, lock, scope and durable protection.
 * Parsing supplied bytes is not enrollment or material admission authority. */
bool general_initialization_plan_parse(const unsigned char *bytes, size_t size, general_initialization_plan *out);
bool general_initialization_record_parse(const unsigned char *bytes, size_t size, general_initialization_record *out);
bool general_initialization_plan_valid(const general_initialization_plan *plan);
bool general_initialization_record_valid(const general_initialization_record *record);
bool general_initialization_binding_valid(const general_initialization_record *record, const general_initialization_plan *plan);
bool general_initialization_advance_valid(const general_initialization_record *before, const general_initialization_record *after, const general_initialization_plan *plan);
/* Output bytes and size remain unchanged on failure. */
bool general_initialization_plan_encode(const general_initialization_plan *plan, unsigned char *out, size_t capacity, size_t *size);
bool general_initialization_record_encode(const general_initialization_record *record, unsigned char *out, size_t capacity, size_t *size);
#endif
