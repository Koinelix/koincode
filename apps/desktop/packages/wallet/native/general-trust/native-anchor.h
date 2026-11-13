#ifndef KOINCODE_GENERAL_NATIVE_ANCHOR_H
#define KOINCODE_GENERAL_NATIVE_ANCHOR_H
#include "native-head.h"
#include "session-installation.h"

typedef enum {
  GENERAL_NATIVE_ANCHOR_INVALID, GENERAL_NATIVE_ANCHOR_UNAVAILABLE,
  GENERAL_NATIVE_ANCHOR_MISSING, GENERAL_NATIVE_ANCHOR_FOUND
} general_native_anchor_status;
typedef enum { GENERAL_NATIVE_ANCHOR_REJECTED, GENERAL_NATIVE_ANCHOR_UNCERTAIN, GENERAL_NATIVE_ANCHOR_ADVANCED } general_native_anchor_write;

/* Native owner only: verified receipt/assignment, actual peer, lease, original scope
 * and journal admission are mandatory. Caller structs are not trust evidence.
 * This adapter never creates/deletes an item or retries an uncertain update.
 * Security calls are synchronous; retain pending ownership until they return. */
general_native_anchor_status general_native_anchor_read(const general_native_identity *identity, const general_session_installation *installation,
  bool (*current)(void *), void *context, general_native_head *out);
general_native_anchor_write general_native_anchor_advance(const general_native_head *expected, const general_native_event *event,
  const general_session_installation *installation, bool (*current)(void *), void *context);
#endif
