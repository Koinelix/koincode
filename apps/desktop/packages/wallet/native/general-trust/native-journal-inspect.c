#include "native-journal-private.h"
#include "native-journal-connection.h"
typedef struct { general_native_journal_connection *owner; bool (*current)(void *); void *context; } inspection;
static bool inspect_current(void *context) {
  inspection *scope = context;
  return scope->current(scope->context) && general_native_journal_connection_current(scope->owner);
}
general_native_replay *general_native_journal_inspect(general_native_journal_connection *owner, const general_native_head *anchor,
  const general_native_scope_resolver *resolver, bool (*current)(void *), void *context) {
  if (!current) return NULL;
  inspection scope = { owner, current, context };
  return general_native_journal_snapshot_private(general_native_journal_connection_database(owner), 0, anchor, resolver, inspect_current, &scope);
}
