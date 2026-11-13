#ifndef KOINCODE_GENERAL_ENROLLMENT_CLIENT_H
#define KOINCODE_GENERAL_ENROLLMENT_CLIENT_H
#include "enrollment-message.h"
#include "enrollment-payload.h"
#include "session-lock.h"
#include "session-installation.h"

typedef struct general_enrollment_client general_enrollment_client;
typedef enum { GENERAL_ENROLLMENT_CLIENT_INVALID, GENERAL_ENROLLMENT_CLIENT_READY, GENERAL_ENROLLMENT_CLIENT_UNCERTAIN } general_enrollment_client_result;
/* Private transport only, never authentication, Add, ready or signing authority.
 * Original actor retains its verified receipt/profile, namespace, locks and all
 * genuine initialization/auth/DP-prefix facts throughout this owner's lifetime.
 * Output must be empty. Does not create/replace/remove a socket or reconnect. */
general_enrollment_client_result general_enrollment_client_open(int directory, general_session_locks *locks,
  const general_session_installation *receipt, bool (*current)(void *), void *context, general_enrollment_client **out);
bool general_enrollment_client_hello(general_enrollment_client *owner, general_enrollment_hello *out);
/* One native substage loan pins the original client until its actual IO drains.
 * Borrowers never close it. Correlation only, never Add/auth/phase authority. */
bool general_enrollment_client_borrow(general_enrollment_client *owner);
bool general_enrollment_client_return(general_enrollment_client *owner);
/* Exactly reserve/start_head/assign, distinct IDs, strict original payloads.
 * The actor authenticates before reserve and proves DP prefix before assign.
 * INVALID is pre-send validation only. Any admitted round failure is terminal
 * UNCERTAIN, even a remote rejection; never automatically repeat a side effect.
 * COMPLETE local round means the exact remote OK, not a protection capability. */
general_enrollment_client_result general_enrollment_client_request(general_enrollment_client *owner,
  const general_enrollment_request *request, const unsigned char *value, size_t size);
/* Additional native lifetime can only narrow the original client's checks.
 * It must not call back into this client. No wire or authority is added. */
general_enrollment_client_result general_enrollment_client_request_scoped(general_enrollment_client *owner,
  const general_enrollment_request *request, const unsigned char *value, size_t size, bool (*current)(void *), void *context);
/* Close immediately after the last reply; Root waits for this EOF. Known close
 * does not imply rollback. Unknown cleanup retains owner, never retries. */
bool general_enrollment_client_close(general_enrollment_client **owner);
#endif
