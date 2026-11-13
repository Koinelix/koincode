#ifndef KOINCODE_GENERAL_SESSION_DISPATCH_H
#define KOINCODE_GENERAL_SESSION_DISPATCH_H
#include "session-guard.h"
#include "session-reply.h"
typedef struct general_session_dispatch general_session_dispatch;
typedef enum { GENERAL_DISPATCH_WAIT, GENERAL_DISPATCH_BUSINESS, GENERAL_DISPATCH_CONTROL,
  GENERAL_DISPATCH_REJECTED, GENERAL_DISPATCH_BROKEN } general_session_dispatch_result;
/* Private transport actor only. The caller retains the genuine peer fd,
 * namespace/locks/child/window/profile and a nonrecursive connection lifetime.
 * This owner cannot authenticate, inspect records or authorize target IO. */
general_session_dispatch *general_session_dispatch_create(int fd, bool (*current)(void *), void *context);
bool general_session_dispatch_start(general_session_dispatch *owner);
general_session_dispatch_result general_session_dispatch_poll(general_session_dispatch *owner);
/* Borrow one original slot; immutable pointers expire only on return followed
 * by actual completion/flush. Return alone never proves policy/OS IO drainage. */
bool general_session_dispatch_borrow(general_session_dispatch *owner, bool control,
  const general_session_request **request, const unsigned char **value, size_t *size);
bool general_session_dispatch_return(general_session_dispatch *owner, bool control);
/* Only while borrowing the original no-value resource commit. Actual two
 * kernel-received descriptors, never numeric wire fields; still not file,
 * lease/schema, ticket, authentication or resource-creation authority. */
bool general_session_dispatch_resource_descriptors_borrow(general_session_dispatch *owner, int *database, int *writer_lease);
bool general_session_dispatch_resource_descriptors_return(general_session_dispatch *owner);
/* One original guard loan for native authentication queries only. The caller
 * must not admit, finish, invalidate or destroy this independently owned guard. */
general_session_guard *general_session_dispatch_guard_borrow(general_session_dispatch *owner);
bool general_session_dispatch_guard_return(general_session_dispatch *owner);
/* Only the original backend's actual terminal callback may complete a slot.
 * It must independently prove policy/worker/OS IO drainage and command gates.
 * Completion records transport state; it never grants record/signing authority. */
bool general_session_dispatch_complete(general_session_dispatch *owner, bool control,
  const general_session_reply *reply, const unsigned char *value, size_t size);
/* Separate flush permits either legal business/control response order. No new
 * ingress is admitted while any completed reply remains owned. */
bool general_session_dispatch_flush(general_session_dispatch *owner, bool control);
/* Actual actor only, after authenticators/keys/workers truly drain. */
bool general_session_dispatch_scope_drained(general_session_dispatch *owner, const char *operation_id);
void general_session_dispatch_stop(general_session_dispatch *owner);
/* Refuses active slots/loans/scopes; never closes the borrowed fd or UID locks. */
bool general_session_dispatch_close(general_session_dispatch **owner);
#endif
