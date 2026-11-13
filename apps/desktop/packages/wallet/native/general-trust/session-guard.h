#ifndef KOINCODE_GENERAL_SESSION_GUARD_H
#define KOINCODE_GENERAL_SESSION_GUARD_H
#include "session-request.h"
#include <time.h>

#define GENERAL_SESSION_REQUEST_LIMIT 65536U
typedef struct general_session_guard general_session_guard;
typedef enum {
  GENERAL_SESSION_ADMIT_INVALID, GENERAL_SESSION_ADMIT_BUSINESS, GENERAL_SESSION_ADMIT_CONTROL,
  GENERAL_SESSION_ADMIT_BUSY, GENERAL_SESSION_ADMIT_REJECTED, GENERAL_SESSION_ADMIT_CLOSING
} general_session_admission;
typedef enum {
  GENERAL_SESSION_FINISH_OK, GENERAL_SESSION_FINISH_REJECTED,
  GENERAL_SESSION_FINISH_CANCELED, GENERAL_SESSION_FINISH_UNCERTAIN
} general_session_completion;
typedef enum { GENERAL_SESSION_DRAIN_REFUSED, GENERAL_SESSION_DRAIN_CURRENT, GENERAL_SESSION_DRAIN_REVOKED } general_session_drain;

/* Serial native-owner calls with parsed requests only. Tracks transport ownership, never authentication or IO authority. */
general_session_guard *general_session_guard_create(const char *session_id);
general_session_admission general_session_guard_admit(general_session_guard *guard, const general_session_request *request, size_t value_size);
bool general_session_guard_business_current(const general_session_guard *guard, const char *request_id);
/* Exact parsed metadata of the current business slot; payload validation and
 * native IO authorization remain with the original actor. */
bool general_session_guard_command_current(const general_session_guard *guard, const general_session_request *request);
/* Original begin binding and admission time only, never auth or IO authority.
 * Serialized owner calls; outputs unchanged on mismatch. */
bool general_session_guard_begin_current(const general_session_guard *guard, const general_session_request *begin);
bool general_session_guard_operation_current(const general_session_guard *guard, const general_session_request *begin);
bool general_session_guard_begin_started(const general_session_guard *guard, const general_session_request *begin, struct timespec *out);
/* Finish only after real callbacks/resources drain. The return classifies the former lifetime, not authorization. */
general_session_drain general_session_guard_finish_business(general_session_guard *guard, const char *request_id, general_session_completion completion);
bool general_session_guard_finish_control(general_session_guard *guard, const char *request_id);
bool general_session_guard_scope_drained(general_session_guard *guard, const char *operation_id);
void general_session_guard_invalidate(general_session_guard *guard);
/* Refuses outstanding work or scope. The caller retains the pointer on refusal. */
bool general_session_guard_destroy(general_session_guard **owner);
#endif
