#ifndef KOINCODE_GENERAL_ENROLLMENT_MESSAGE_H
#define KOINCODE_GENERAL_ENROLLMENT_MESSAGE_H
#include "enrollment-request.h"

typedef enum { GENERAL_ENROLLMENT_PREPARATION_NONE, GENERAL_ENROLLMENT_FRESH, GENERAL_ENROLLMENT_RESUME } general_enrollment_preparation;
typedef enum { GENERAL_ENROLLMENT_STATUS_NONE, GENERAL_ENROLLMENT_OK, GENERAL_ENROLLMENT_REJECTED, GENERAL_ENROLLMENT_UNCERTAIN } general_enrollment_status;
typedef struct {
  uint32_t uid;
  char installation_id[37];
  uint64_t receipt_revision;
  general_enrollment_preparation preparation;
} general_enrollment_hello;
typedef struct { const general_enrollment_request *request; general_enrollment_status *status; } general_enrollment_reply_validation;
/* Structural codecs only. Root/native actors retain actual peer, fresh-directory,
 * scope, lock, registration phase and durable readback proof. No value is allowed
 * on these messages; callers must reject and clear frames with a nonzero value. */
bool general_enrollment_hello_parse(const unsigned char *bytes, size_t size, general_enrollment_hello *out);
bool general_enrollment_hello_metadata_valid(const unsigned char *bytes, size_t size, void *out);
bool general_enrollment_hello_encode(const general_enrollment_hello *hello, general_session_wire *out);
bool general_enrollment_reply_parse(const unsigned char *bytes, size_t size, const general_enrollment_request *request, general_enrollment_status *out);
bool general_enrollment_reply_metadata_valid(const unsigned char *bytes, size_t size, void *context);
bool general_enrollment_reply_encode(const general_enrollment_request *request, general_enrollment_status status, general_session_wire *out);
#endif
