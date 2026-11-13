#ifndef KOINCODE_GENERAL_BROKER_NAMESPACE_H
#define KOINCODE_GENERAL_BROKER_NAMESPACE_H
#include "console-identity.h"
#include "registration-io.h"
#include "session-installation.h"
#include "session-lock.h"

typedef struct general_broker_namespace general_broker_namespace;
typedef enum { GENERAL_BROKER_NAMESPACE_UNAVAILABLE, GENERAL_BROKER_NAMESPACE_BUSY,
  GENERAL_BROKER_NAMESPACE_READY, GENERAL_BROKER_NAMESPACE_UNCERTAIN } general_broker_namespace_result;
/* Fixed nonroot physical namespace, never profile/auth/ready authority. No path,
 * UID or receipt input. Callback is the original actor's base lifetime and must
 * not recursively call this namespace. One serialized owner per process. */
general_broker_namespace_result general_broker_namespace_open(bool (*current)(void *), void *context, general_broker_namespace **out);
/* Point snapshot only; independent UID directory SH excludes Root enrollment.
 * Ordinary manager admission deliberately does not take that shared lock. */
general_broker_namespace_result general_broker_namespace_open_inspection(bool (*current)(void *), void *context, general_broker_namespace **out);
bool general_broker_namespace_current(general_broker_namespace *owner);
bool general_broker_namespace_info(general_broker_namespace *owner, general_console_identity *console, general_session_installation *receipt);
/* Derived actual metadata, never a cached accepted phase or fresh/Add license.
 * Output unchanged on failure. Does not normalize or create missing records. */
bool general_broker_namespace_inspect(general_broker_namespace *owner, general_registration_view *out);
/* Single synchronous IO loan; caller must never close/unlock either resource.
 * The original actor still owns all profile/peer/auth/initialization gates. */
bool general_broker_namespace_borrow(general_broker_namespace *owner, int *directory, general_session_locks **locks);
bool general_broker_namespace_return(general_broker_namespace *owner);
/* Independent lifetime pin for the one original controlled Host. It lends no
 * directory/locks/IO and cannot establish a profile or command scope. The
 * actual launcher returns it only after child/peer/window drainage and reap. */
bool general_broker_namespace_borrow_child(general_broker_namespace *owner);
bool general_broker_namespace_return_child(general_broker_namespace *owner);
/* Terminal native cleanup only, after actual Host/IO/loans have drained. This
 * can never resume as a user namespace. Installation remains pinned to reply. */
bool general_broker_namespace_release_user(general_broker_namespace *owner);
bool general_broker_namespace_installation_current(general_broker_namespace *owner);
/* No close retry; unknown cleanup retains original locks and process slot. */
bool general_broker_namespace_close(general_broker_namespace **owner);
#endif
