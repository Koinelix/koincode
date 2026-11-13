#ifndef KOINCODE_GENERAL_ENROLLMENT_PAYLOAD_H
#define KOINCODE_GENERAL_ENROLLMENT_PAYLOAD_H
#include "enrollment-request.h"
#include "initialization.h"

typedef struct {
  general_enrollment_command command;
  union {
    general_initialization_plan reserve;
    struct { general_native_head head; general_initialization_record initialization; } assign;
  } body;
} general_enrollment_payload;
/* Fixed approved metadata only. Assign requires the original frozen reservation
 * plan, not a caller boolean. Actual actors still own peer/auth/OFD/registration
 * stages, genuine DP head and accepted-prefix proof. No IO or creation authority. */
bool general_enrollment_payload_parse(const general_enrollment_request *request, const unsigned char *bytes, size_t size,
  const general_initialization_plan *original, general_enrollment_payload *out);
#endif
