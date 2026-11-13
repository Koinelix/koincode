#ifndef KOINCODE_GENERAL_SESSION_FRAME_PRIVATE_H
#define KOINCODE_GENERAL_SESSION_FRAME_PRIVATE_H
#include "session-frame.h"
/* Transport implementation detail for the fixed resource-commit encoder.
 * Not a JS factory, pair identity, ticket, schema or authentication proof. */
general_session_frame_result general_session_frame_write_pair(int fd, const int descriptors[2], unsigned timeout_ms, general_session_wire *wire,
  general_session_metadata_validator validate, void *validation_context, general_session_frame_current current, void *current_context);
#endif
