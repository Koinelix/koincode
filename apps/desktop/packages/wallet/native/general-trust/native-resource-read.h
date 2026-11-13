#ifndef KOINCODE_GENERAL_NATIVE_RESOURCE_READ_H
#define KOINCODE_GENERAL_NATIVE_RESOURCE_READ_H
#include "native-record.h"
#include "resource-record.h"
/* Fixed resource metadata only. The original genuine actor retains the current
 * protected prefix, scope, origin/profile gates, code/peer/window and locks.
 * A valid record/created stage proves no actual file, ticket or permission.
 * No arbitrary reference/account, mutation, key/signed read or retry exists.
 * All failure statuses preserve output; missing never authorizes creation. */
general_native_record_status general_native_resource_read(const general_native_identity *identity,
  const general_session_installation *installation, const general_native_replay *replay,
  general_resource_kind kind, const char *profile, bool (*current)(void *), void *context, general_resource_record *out);
#endif
