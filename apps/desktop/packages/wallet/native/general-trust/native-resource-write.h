#ifndef KOINCODE_GENERAL_NATIVE_RESOURCE_WRITE_H
#define KOINCODE_GENERAL_NATIVE_RESOURCE_WRITE_H
#include "native-resource-read.h"
#include "native-journal-connection.h"

typedef struct general_native_resource_writer general_native_resource_writer;
typedef enum { GENERAL_RESOURCE_WRITE_REJECTED, GENERAL_RESOURCE_WRITE_UNCERTAIN,
  GENERAL_RESOURCE_WRITE_COMMITTED, GENERAL_RESOURCE_WRITE_IDENTICAL } general_resource_write_status;
/* Native actor only. Retains one loan on the original physical journal. The
 * actor must retain genuine peer, namespace/UID locks, profile, origin, scope,
 * window and parent/file gates; metadata never proves those facts. No JS port,
 * caller account/path, file creation, tail repair or material access exists.
 * Resolver/context and original resource owners must outlive this owner.
 * Every attempt is bounded by the original current callback and 30 seconds. */
general_native_resource_writer *general_native_resource_writer_create(general_native_journal_connection *journal,
  const general_native_identity *identity, const general_session_installation *installation,
  const general_native_scope_resolver *resolver, bool (*current)(void *), void *context);
/* Exactly one attempt, including rejection. Freezes next before any callback.
 * Only exact identical committed bytes are an idempotent confirmation. */
general_resource_write_status general_native_resource_writer_write(general_native_resource_writer *owner,
  const general_resource_record *next);
/* Refuses running/uncertain outcomes and retains the original journal loan.
 * No retry, rollback of target effects or false drainage on unknown results. */
bool general_native_resource_writer_close(general_native_resource_writer **owner);
#endif
