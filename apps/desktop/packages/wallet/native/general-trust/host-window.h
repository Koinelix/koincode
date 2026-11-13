#ifndef KOINCODE_GENERAL_HOST_WINDOW_H
#define KOINCODE_GENERAL_HOST_WINDOW_H
#include "host-bootstrap.h"
#include <stdint.h>
typedef struct general_host_window general_host_window;
/* Sealed Host native actor, main thread only. A supplied address is compared
 * with actual AppKit objects and is never dereferenced. Both NSView membership
 * and the WindowServer's original onscreen window/PID must agree. Bootstrap
 * must outlive this owner. Only one registration attempt per Host process. */
bool general_host_window_open(general_host_bootstrap *bootstrap, uintptr_t native_view, uint32_t window_id, general_host_window **out);
bool general_host_window_current(general_host_window *owner);
/* Material consumption/publication additionally requires the actual original
 * key window and active AppKit application. Not used during system policy UI. */
bool general_host_window_sensitive_current(general_host_window *owner);
void general_host_window_invalidate(general_host_window *owner);
bool general_host_window_close(general_host_window **owner);
#endif
