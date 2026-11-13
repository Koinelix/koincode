#ifndef KOINCODE_GENERAL_SESSION_INGRESS_H
#define KOINCODE_GENERAL_SESSION_INGRESS_H
#include "session-request.h"
typedef struct general_session_ingress general_session_ingress;
typedef struct general_session_rights general_session_rights;
typedef enum { GENERAL_INGRESS_WAIT, GENERAL_INGRESS_READY, GENERAL_INGRESS_EOF,
  GENERAL_INGRESS_INVALID, GENERAL_INGRESS_CANCELED, GENERAL_INGRESS_TIMEOUT,
  GENERAL_INGRESS_IO_ERROR, GENERAL_INGRESS_FATAL } general_session_ingress_result;
/* Private serialized broker IO only. Borrow the actor's original verified
 * nonblocking/CLOEXEC socket; never close it or change its flags. No trust,
 * authentication, scope or material authority follows from frame readiness.
 * current must retain genuine actor gates without recursively calling here. */
general_session_ingress *general_session_ingress_create(int fd, bool (*current)(void *), void *context);
/* One recvmsg, at most 64 KiB; no wait/poll. FATAL mandates dedicated-process
 * termination because ancillary truncation/unknown cleanup may hide fds. */
general_session_ingress_result general_session_ingress_step(general_session_ingress *owner);
/* Moves one complete owned frame. Output frame must be empty. Failure leaves
 * both outputs unchanged. The actor separately admits it through its guard. */
bool general_session_ingress_take(general_session_ingress *owner, general_session_request *request, general_session_frame *frame);
/* Moves only kernel-received rights on the first byte of a no-value resource
 * commit. Exactly two are ordered database, writer lease; their actual kind,
 * retained parent/inodes, schema and Host lock owner still require verification.
 * No constructor from a caller fd or JSON number exists. Output must be empty. */
bool general_session_ingress_take_with_rights(general_session_ingress *owner, general_session_request *request,
  general_session_frame *frame, general_session_rights **rights);
bool general_session_rights_borrow(general_session_rights *owner, int *database, int *writer_lease);
bool general_session_rights_return(general_session_rights *owner);
/* Refuses live loans and retains unknown close without another close attempt. */
bool general_session_rights_close(general_session_rights **owner);
/* Never closes the borrowed socket. Unknown ancillary state retains owner. */
bool general_session_ingress_close(general_session_ingress **owner);
#endif
