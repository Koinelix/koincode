#ifndef KOINCODE_GENERAL_RESOURCE_SESSION_H
#define KOINCODE_GENERAL_RESOURCE_SESSION_H
#include "native-resource-write.h"
#include "resource-repository-verify.h"
#include "session-request.h"
#include "session-reply.h"

typedef struct general_resource_session general_resource_session;
typedef struct general_host_launch general_host_launch;
typedef enum { GENERAL_RESOURCE_ORIGIN_PREPARING, GENERAL_RESOURCE_ORIGIN_ACTIVE } general_resource_origin_phase;
typedef struct {
  int parent;
  general_resource_origin origin;
  char origin_id[37], origin_digest[65];
  general_resource_origin_phase phase;
} general_resource_origin_view;
/* Native-only live origin resolver. It must read the actual assignment,
 * initialization/RestorePlan/active view and retain the fixed parent loan.
 * Never implement from JS, caller paths, booleans or supplied record bytes.
 * This describes original facts, not a portable creation capability. */
typedef struct {
  bool (*resolve)(general_resource_kind kind, const char *profile, general_resource_origin_view *out, void *context);
  void *context;
} general_resource_origin_resolver;
/* Genuine actor retains original namespace/UID locks, authentication scope,
 * exact Host/window/code/profile and historical resolver through close.
 * One session, 16 tickets, at most one in-progress create. No file creation
 * occurs here: start anchors before the sealed Host's one actual callback. */
general_resource_session *general_resource_session_create(general_native_journal_connection *journal,
  const general_native_identity *identity, const general_session_installation *installation,
  const general_native_scope_resolver *history, const general_resource_origin_resolver *origin,
  general_channel_peer *host, bool (*current)(void *), void *context);
/* Exact parsed no-value resource request; descriptors come only from original
 * dispatch's kernel-received loan, ordered database/lease. -1,-1 for no rights.
 * Reply is written only for a known outcome. No caller path/ref/create flag.
 * The actual dispatcher still admits the envelope and original auth scope. */
bool general_resource_session_execute(general_resource_session *owner, const general_session_request *request,
  int database, int writer_lease, general_session_reply *reply);
/* Inspection only opens original CREATED resources under an actual ACTIVE
 * origin. No Add, target creation, write_started or metadata mutation. The
 * actual connection actor selects this entry for its inspection scope. */
bool general_resource_session_execute_readonly(general_resource_session *owner, const general_session_request *request,
  int database, int writer_lease, general_session_reply *reply);
/* Original retained committed state/signing tickets and actual Host SQLite
 * locks, not caller flags. No new scope, file creation or SQL is admitted.
 * Basic initial-new publication uses this before/through metadata target IO. */
bool general_resource_session_profile_current(general_resource_session *owner, general_native_journal_connection *journal, const char *profile_id);
/* Shutdown only, after actual original Host reap. Releases known drained
 * tickets without requiring a revoked window/auth scope to become live again.
 * Never deletes targets, clears unknown effects or admits further commands. */
bool general_resource_session_drain_reaped(general_resource_session *owner, general_host_launch *launch);
/* Close never discards live tickets, unknown metadata/file effects or loans.
 * Original Host/policy/OS IO must actually drain before releasing resources. */
bool general_resource_session_close(general_resource_session **owner);
#endif
