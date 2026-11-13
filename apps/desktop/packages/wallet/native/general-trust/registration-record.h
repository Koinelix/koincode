#ifndef KOINCODE_GENERAL_REGISTRATION_RECORD_H
#define KOINCODE_GENERAL_REGISTRATION_RECORD_H
#include "initialization.h"
#define GENERAL_REGISTRATION_RECORD_MAX 16384U

typedef enum { GENERAL_REGISTRATION_PHASE_NONE, GENERAL_REGISTRATION_RESERVED,
  GENERAL_REGISTRATION_HEAD_CREATE_STARTED, GENERAL_REGISTRATION_ASSIGNED } general_registration_phase;
typedef struct { general_native_identity identity; general_registration_phase phase; } general_registration_record;
/* Approved metadata only. The actual root/native actors retain peer, fresh/lock,
 * original authenticated plan, stage IO and durable readback responsibility.
 * A valid record or transition is never new creation or SecItemAdd authority. */
bool general_registration_record_valid(const general_registration_record *record);
bool general_registration_record_parse(const unsigned char *bytes, size_t size, general_registration_record *out);
bool general_registration_record_encode(const general_registration_record *record, unsigned char *out, size_t capacity, size_t *size);
bool general_registration_binding_valid(const general_registration_record *record, const general_initialization_plan *plan);
bool general_registration_advance_valid(const general_registration_record *before, const general_registration_record *after, const general_initialization_plan *plan);
#endif
