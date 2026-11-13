#ifndef KOINCODE_GENERAL_NATIVE_BINDING_H
#define KOINCODE_GENERAL_NATIVE_BINDING_H
#include "domain-binding.h"
#include "native-anchor.h"
/* Private fixed DP metadata read, never an active view or permission. Actual
 * actor retains verified identity/receipt, current peer/profile/window/locks,
 * accepted journal prefix and command gates. Arguments are not provenance.
 * FOUND is structural/attribute association only; MISSING never grants create.
 * No arbitrary ref, write, publish, fallback or automatic retry is supported.
 * Synchronous IO remains owned until it actually returns. Failure preserves out. */
general_native_anchor_status general_native_binding_read(const general_native_identity *identity,
  const general_session_installation *installation, bool (*current)(void *), void *context, general_domain_binding *out);
#endif
