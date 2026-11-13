#ifndef KOINCODE_GENERAL_SESSION_REPLY_H
#define KOINCODE_GENERAL_SESSION_REPLY_H
#include "session-request.h"

typedef enum { GENERAL_REPLY_STATUS_NONE, GENERAL_REPLY_OK, GENERAL_REPLY_REJECTED, GENERAL_REPLY_CANCELED, GENERAL_REPLY_UNCERTAIN } general_session_reply_status;
typedef enum {
  GENERAL_REPLY_CODE_NONE, GENERAL_REPLY_CODE_OK, GENERAL_REPLY_INVALID, GENERAL_REPLY_UNAVAILABLE, GENERAL_REPLY_BUSY,
  GENERAL_REPLY_AUTH_REJECTED, GENERAL_REPLY_AUTH_TIMEOUT, GENERAL_REPLY_CONFLICT, GENERAL_REPLY_CODE_CANCELED,
  GENERAL_REPLY_REGISTRATION_UNCERTAIN
} general_session_reply_code;
typedef enum { GENERAL_REPLY_EMPTY, GENERAL_REPLY_READ_MISSING, GENERAL_REPLY_READ_PRESENT,
  GENERAL_REPLY_INSPECT_UNREGISTERED, GENERAL_REPLY_INSPECT_REGISTERED, GENERAL_REPLY_RESOURCE_PREPARED,
  GENERAL_REPLY_RESOURCE_CREATED, GENERAL_REPLY_RESOURCE_UNREGISTERED, GENERAL_REPLY_RESOURCE_REGISTERED } general_session_reply_kind;
typedef enum { GENERAL_REPLY_RESOURCE_STAGE_NONE, GENERAL_REPLY_RESOURCE_ADMITTED, GENERAL_REPLY_RESOURCE_WRITE_STARTED,
  GENERAL_REPLY_RESOURCE_STAGE_CREATED, GENERAL_REPLY_RESOURCE_UNCERTAIN } general_session_reply_resource_stage;
typedef enum { GENERAL_REPLY_STAGE_NONE, GENERAL_REPLY_ADMITTED, GENERAL_REPLY_WRITE_STARTED,
  GENERAL_REPLY_COMMITTED, GENERAL_REPLY_STAGE_UNCERTAIN } general_session_reply_stage;
typedef struct {
  general_session_reply_status status;
  general_session_reply_code code;
  general_session_reply_kind kind;
  general_session_reply_stage stage;
  bool has_expected;
  char expected_digest[65], next_digest[65];
  char ticket_id[37], creation_id[37]; bool resource_create;
  general_session_reply_resource_stage resource_stage;
} general_session_reply;
typedef struct { const general_session_request *request; general_session_reply *reply; } general_session_reply_validation;

/* Fixed wire shape and original request correlation only. The native actor owns
 * peer/scope/authentication, actual execution outcome and secret-return checks.
 * Parsed metadata never grants authority to consume the accompanying value. */
bool general_session_reply_parse(const unsigned char *bytes, size_t size, const general_session_request *request, general_session_reply *out);
bool general_session_reply_metadata_valid(const unsigned char *bytes, size_t size, void *context);
bool general_session_reply_accepts_value(const general_session_request *request, const general_session_reply *reply, size_t size);
/* Output must be empty. Owned encoded bytes must be wiped with wire_clear. */
bool general_session_reply_encode(const general_session_request *request, const general_session_reply *reply,
  const unsigned char *value, size_t value_size, general_session_wire *out);
bool general_session_hello_encode(const char session_id[37], general_session_wire *out);
#endif
