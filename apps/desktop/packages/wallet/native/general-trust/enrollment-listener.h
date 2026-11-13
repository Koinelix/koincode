#ifndef KOINCODE_GENERAL_ENROLLMENT_LISTENER_H
#define KOINCODE_GENERAL_ENROLLMENT_LISTENER_H
#include <stdbool.h>
#include <stdint.h>
typedef struct general_enrollment_listener general_enrollment_listener;
typedef enum { GENERAL_LISTENER_UNAVAILABLE, GENERAL_LISTENER_BUSY, GENERAL_LISTENER_CONFLICT, GENERAL_LISTENER_READY, GENERAL_LISTENER_UNCERTAIN } general_listener_result;
/* Root-only fixed temporary socket. Directory flock shares the original
 * namespace OFD and lasts until its final reference closes. No owner.lock is
 * acquired. Caller owns the verified namespace/code/console/total lifetime. */
general_listener_result general_enrollment_listener_open(int directory, uint32_t uid, uint32_t gid,
  bool (*current)(void *), void *context, general_enrollment_listener **out);
bool general_enrollment_listener_current(general_enrollment_listener *owner);
/* At most 50 ms readiness wait, then nonblocking accept:
 * 1 owns a new fd, 0 not ready, -1 invalid. */
int general_enrollment_listener_accept(general_enrollment_listener *owner, int *out);
/* Removes only this original bound socket under the retained directory lock.
 * Unknown cleanup never retries; retain owner to process exit. */
bool general_enrollment_listener_close(general_enrollment_listener **owner);
#endif
