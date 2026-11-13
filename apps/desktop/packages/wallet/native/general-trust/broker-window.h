#ifndef KOINCODE_GENERAL_BROKER_WINDOW_H
#define KOINCODE_GENERAL_BROKER_WINDOW_H
#include "host-launch.h"
typedef struct general_broker_window general_broker_window;
/* Native actor consumes the original window.ready slot, never a public Main
 * window ID. Holds the same original unreaped child/peer until actual close.
 * Window observation grants no authentication, profile or material authority. */
bool general_broker_window_open(general_host_launch *launch, uint32_t window_id, general_broker_window **out);
bool general_broker_window_current(general_broker_window *owner);
void general_broker_window_invalidate(general_broker_window *owner);
bool general_broker_window_close(general_broker_window **owner);
#endif
