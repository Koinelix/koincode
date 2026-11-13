#ifndef KOINCODE_GENERAL_HOST_RESOURCES_H
#define KOINCODE_GENERAL_HOST_RESOURCES_H
#include "../general-trust/host-bootstrap.h"
#include "../general-trust/initialization.h"
#include "../general-trust/session-reply.h"
#include "repository-sql.h"
typedef struct general_host_resources general_host_resources;
typedef enum { GENERAL_HOST_RESOURCES_CLOSED, GENERAL_HOST_RESOURCES_BUSY, GENERAL_HOST_RESOURCES_UNCERTAIN } general_host_resources_close_result;
/* Sealed bridge only, after its actual original channel accepted this Root
 * initialization metadata. The record alone is not admission. No NAPI factory
 * accepts this struct, a caller path, FD, permit or create boolean. The bridge
 * retains bootstrap/window and supplies their nonrecursive actual lifetime. */
general_host_resources *general_host_resources_open(general_host_bootstrap *bootstrap,
  const general_initialization_record *initialization, bool (*current)(void *), void *context);
/* Only the bridge's actual matched kernel reply callback calls this; never a
 * JS-provided acknowledgement. Scope/Root/origin stay with the real broker. */
bool general_host_resources_observe(general_host_resources *owner, const general_session_request *original, const general_session_reply *actual);
/* The kind chooses a fixed recipe, never creation authority. Native accepted
 * prepare/start acknowledgements supply the original retained ticket. */
bool general_host_resources_materialize(general_host_resources *owner, general_resource_kind kind);
/* Actual native descriptors only, held through sending AND matched reply.
 * count=0 for directories, 2 for the exact original live repository pair. */
bool general_host_resources_commit_borrow(general_host_resources *owner, const general_session_request *original, int descriptors[2], unsigned *count);
bool general_host_resources_current(general_host_resources *owner);
bool general_host_resources_matches(general_host_resources *owner, const general_initialization_record *initialization);
bool general_host_resources_repository_ready(general_host_resources *owner, general_repository_kind kind);
general_sql_status general_host_resources_execute(general_host_resources *owner, general_repository_kind kind,
  general_sql_recipe recipe, const general_sql_parameter *parameters, size_t count, general_sql_result **out);
general_repository_close_result general_host_resources_close_repository(general_host_resources *owner, general_repository_kind kind);
/* Unknown target or close keeps all remaining original owners until reap. */
general_host_resources_close_result general_host_resources_close(general_host_resources **owner);
#endif
