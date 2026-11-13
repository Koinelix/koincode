#ifndef KOINCODE_GENERAL_RESOURCE_COMMIT_SEND_H
#define KOINCODE_GENERAL_RESOURCE_COMMIT_SEND_H
#include "session-request.h"
/* Only the sealed native resource actor may lend its actual pair descriptors.
 * This validates the commit wire, not ticket provenance, schema or pair locks.
 * Caller retains the original pair loan through send AND broker completion.
 * Partial/unknown delivery never authorizes retry or return of that pair. */
general_session_frame_result general_resource_commit_send(int socket, int database, int writer_lease, unsigned timeout_ms,
  general_session_wire *wire, general_session_frame_current current, void *context);
#endif
