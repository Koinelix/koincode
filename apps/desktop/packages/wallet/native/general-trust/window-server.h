#ifndef KOINCODE_GENERAL_WINDOW_SERVER_H
#define KOINCODE_GENERAL_WINDOW_SERVER_H
#include <stdbool.h>
#include <stdint.h>
#include <sys/types.h>
/* OS observation only. The original actor establishes which PID/version/window
 * belongs to its genuine peer; these caller values are not authorization. */
bool general_window_server_matches(uint32_t window_id, pid_t pid);
#endif
