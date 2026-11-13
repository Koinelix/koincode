#ifndef KOINCODE_GENERAL_SESSION_LOCK_H
#define KOINCODE_GENERAL_SESSION_LOCK_H
#include <stdbool.h>

typedef struct general_session_locks general_session_locks;
typedef enum { GENERAL_SESSION_LOCK_INVALID, GENERAL_SESSION_LOCK_BUSY, GENERAL_SESSION_LOCK_READY, GENERAL_SESSION_LOCK_UNCERTAIN } general_session_lock_result;
/* Physical resources only. Actual actors own the fixed namespace/console UID,
 * code/receipt/peer/auth/fresh/operation proof. Never a signing capability.
 * Output must be empty. Known cleanup errors retain an unreleasable owner. */
general_session_lock_result general_session_locks_broker_open(int installation, int user, bool (*current)(void *), void *context, general_session_locks **out);
/* Snapshot only: installation SH, independent existing UID directory SH, then
 * owner EX. Never lends the owner lock to a Root initialization client. */
general_session_lock_result general_session_locks_broker_inspection_open(int installation, int user, bool (*current)(void *), void *context, general_session_locks **out);
/* After role/resource admission this moves the received fd and sets it to -1.
 * Before admission it remains caller-owned. Never pass the caller's own lease. */
general_session_lock_result general_session_locks_enrollment_open(int installation, int user, int *received, bool (*current)(void *), void *context, general_session_locks **out);
/* Root preparation begins before a UID directory or received owner fd exists.
 * The same installation SH reference remains alive through later adoption. */
general_session_lock_result general_session_locks_enrollment_begin(int installation, bool (*current)(void *), void *context, general_session_locks **out);
general_session_lock_result general_session_locks_enrollment_adopt(general_session_locks *owner, int user, int *received, bool (*current)(void *), void *context);
bool general_session_locks_installation_current(general_session_locks *owner);
bool general_session_locks_current(general_session_locks *owner);
/* Broker-only one IO loan. Never close/unlock this fd. Return only after the
 * actual SCM_RIGHTS send drains; close refuses an outstanding loan. */
int general_session_locks_borrow_owner(general_session_locks *owner);
bool general_session_locks_return_owner(general_session_locks *owner);
/* Actual broker after child/IO drainage only. Ends its UID guard while the
 * same original installation SH remains held through the public reply. */
bool general_session_locks_release_user(general_session_locks *owner);
/* No explicit LOCK_UN or close retry. Unknown close retains to process exit. */
bool general_session_locks_close(general_session_locks **owner);
#endif
