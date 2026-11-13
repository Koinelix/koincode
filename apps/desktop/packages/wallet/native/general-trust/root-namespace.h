#ifndef KOINCODE_GENERAL_ROOT_NAMESPACE_H
#define KOINCODE_GENERAL_ROOT_NAMESPACE_H
#include "console-identity.h"
#include "session-installation.h"
#include "registration-io.h"

typedef struct general_root_namespace general_root_namespace;
typedef enum { GENERAL_ROOT_NAMESPACE_UNAVAILABLE, GENERAL_ROOT_NAMESPACE_BUSY, GENERAL_ROOT_NAMESPACE_CONFLICT,
  GENERAL_ROOT_NAMESPACE_READY, GENERAL_ROOT_NAMESPACE_UNCERTAIN } general_root_namespace_result;
typedef enum { GENERAL_ROOT_PREPARATION_NONE, GENERAL_ROOT_PREPARATION_FRESH, GENERAL_ROOT_PREPARATION_RESUME } general_root_preparation;
/* Fixed root preparation verifies its own code/static distribution before
 * creating the UID leaf. Actual profile/peer/auth/initialization proof remains
 * actor-owned. No root CLI or caller path/UID.
 * Unknown effects or close retain the owner/locks until process exit. */
general_root_namespace_result general_root_namespace_prepare(bool (*current)(void *), void *context, general_root_namespace **out);
bool general_root_namespace_current(general_root_namespace *owner);
bool general_root_namespace_info(general_root_namespace *owner, general_console_identity *identity, general_session_installation *receipt, general_root_preparation *preparation);
general_root_namespace_result general_root_namespace_adopt_owner(general_root_namespace *owner, int *received, bool (*current)(void *), void *context);
/* Borrowed resources must never be closed. Return only after actual listener
 * or metadata command IO drains; namespace close refuses outstanding loans. */
int general_root_namespace_borrow_directory(general_root_namespace *owner);
bool general_root_namespace_return_directory(general_root_namespace *owner);
general_registration_io *general_root_namespace_borrow_records(general_root_namespace *owner);
bool general_root_namespace_return_records(general_root_namespace *owner);
bool general_root_namespace_close(general_root_namespace **owner);
#endif
