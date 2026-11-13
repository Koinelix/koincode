#ifndef KOINCODE_GENERAL_RESOURCE_REPOSITORY_VERIFY_H
#define KOINCODE_GENERAL_RESOURCE_REPOSITORY_VERIFY_H
#include "channel-peer.h"
#include "resource-record.h"
typedef struct { general_resource_file_identity directory, database, writer_lease; } general_resource_repository_identity;
/* Broker-private, on original kernel-received descriptors and retained fixed
 * target directory only. The actual actor retains ticket, origin, parent,
 * profile/scope/window/namespace locks and revalidates them through current.
 * Independently checks named/held files and the original Host's SQLite lock.
 * No open/close/unlock, SQL, caller path, creation or authorization follows.
 * The actual same-pair/schema proof remains in the sealed native Host bridge.
 * Output stays unchanged on failure. One original 30-second budget. */
bool general_resource_repository_verify(int directory, int database, int writer_lease, general_resource_kind kind,
  general_channel_peer *host, bool (*current)(void *), void *context, general_resource_repository_identity *out);
#endif
