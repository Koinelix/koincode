#ifndef KOINCODE_GENERAL_NATIVE_JOURNAL_APPEND_H
#define KOINCODE_GENERAL_NATIVE_JOURNAL_APPEND_H
#include "native-journal-read.h"
#include "native-anchor.h"

typedef enum { GENERAL_NATIVE_APPEND_REJECTED, GENERAL_NATIVE_APPEND_UNCERTAIN, GENERAL_NATIVE_APPEND_ANCHORED } general_native_append_status;
/* Native owner only. Real peer/scope/lease, fixed resources, actual SQLite fd identity
 * and the physical DB+WAL budget must already be verified and remain current.
 * This borrows a dedicated writable connection and never closes or creates it.
 * ANCHORED describes one metadata stage, not target IO or spending authority.
 * Existing tails require explicit original-operation recovery, never this append. */
general_native_append_status general_native_journal_append(sqlite3 *connection, const general_native_head *expected,
  const general_native_event *event, const general_session_installation *installation, const general_native_scope_resolver *resolver,
  bool (*current)(void *), void *context);
/* Explicit original-operation recovery only, after genuine reauthentication and
 * revalidation of original bytes, actual target facts and every stage gate.
 * Never call from inspection/reopen. This does not retry target IO or clear risk;
 * rejection does not erase an existing unknown outcome. No row is mutated. */
general_native_append_status general_native_journal_recover_tail(sqlite3 *connection, const general_native_head *expected,
  const general_native_event *event, const general_session_installation *installation, const general_native_scope_resolver *resolver,
  bool (*current)(void *), void *context);
#endif
