#ifndef KOINCODE_GENERAL_ENROLLMENT_REQUEST_H
#define KOINCODE_GENERAL_ENROLLMENT_REQUEST_H
#include "session-frame.h"
#include "session-canonical.h"

typedef enum { GENERAL_ENROLLMENT_NONE, GENERAL_ENROLLMENT_RESERVE, GENERAL_ENROLLMENT_START_HEAD, GENERAL_ENROLLMENT_ASSIGN } general_enrollment_command;
typedef struct { char request_id[37]; general_enrollment_command command; } general_enrollment_request;
/* Fixed approved envelope only; actual initialization/record validation and root
 * peer/lock/authentication/stage/replay admission belong to the native actor. */
bool general_enrollment_request_parse(const unsigned char *bytes, size_t size, general_enrollment_request *out);
general_session_frame_result general_enrollment_request_read(int fd, unsigned timeout_ms, general_session_frame_current current,
  void *context, general_session_frame *frame, general_enrollment_request *request, int *owner_lock);
#endif
