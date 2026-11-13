#ifndef KOINCODE_GENERAL_NATIVE_JOURNAL_READ_H
#define KOINCODE_GENERAL_NATIVE_JOURNAL_READ_H
#include "native-replay.h"
#include <sqlite3.h>

/* Private native owner only. This borrowed connection must be dedicated and read-only.
 * The owner verifies actual files/lease, physical DB+WAL size and genuine DP anchor,
 * and rechecks them before using a result. A successful snapshot is not IO authority.
 * No transaction, prepared statement, progress handler or attached schema may be shared.
 * Configuration changes remain on the connection; this function never closes it. */
general_native_replay *general_native_journal_read(sqlite3 *connection, const general_native_head *anchor,
  const general_native_scope_resolver *resolver, bool (*current)(void *), void *context);

/* Reuses the exclusive retained-file owner instead of opening an observer.
 * The result is metadata evidence only, never target IO or signing authority. */
typedef struct general_native_journal_connection general_native_journal_connection;
general_native_replay *general_native_journal_inspect(general_native_journal_connection *owner, const general_native_head *anchor,
  const general_native_scope_resolver *resolver, bool (*current)(void *), void *context);

#endif
