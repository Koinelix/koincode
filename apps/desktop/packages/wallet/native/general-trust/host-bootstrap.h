#ifndef KOINCODE_GENERAL_HOST_BOOTSTRAP_H
#define KOINCODE_GENERAL_HOST_BOOTSTRAP_H
#include "channel-peer.h"
#include "host-bootstrap-wire.h"

typedef struct general_host_bootstrap general_host_bootstrap;
typedef enum { GENERAL_HOST_BOOTSTRAP_UNAVAILABLE, GENERAL_HOST_BOOTSTRAP_READY, GENERAL_HOST_BOOTSTRAP_UNCERTAIN } general_host_bootstrap_result;
/* The sealed Host's first native entry, before any renderer/worker exists.
 * Consumes only the original fd 3 and connects to its one bounded rendezvous.
 * No caller path/fd/identity/fresh flags or JS callbacks are accepted. This
 * proves physical bootstrap only, never scope, profile or material authority. */
general_host_bootstrap_result general_host_bootstrap_open(general_host_bootstrap **out);
/* Fixed payment-owner entry only. Installation/code/OS-user gate, without a
 * Host bootstrap, peer, mode, profile or source-key authority. It cannot borrow
 * the management channel or construct management resources. */
general_host_bootstrap_result general_payment_owner_bootstrap_open(general_host_bootstrap **out);
bool general_payment_owner_bootstrap_info(general_host_bootstrap *owner, general_session_installation *receipt);
bool general_host_bootstrap_current(general_host_bootstrap *owner);
bool general_host_bootstrap_info(general_host_bootstrap *owner, general_host_mode *mode, general_session_installation *receipt);
/* One private native IO loan, not a numeric JS descriptor. No close/unlock. */
int general_host_bootstrap_borrow(general_host_bootstrap *owner);
bool general_host_bootstrap_return(general_host_bootstrap *owner);
void general_host_bootstrap_invalidate(general_host_bootstrap *owner);
/* Unknown cleanup retains all remaining references until actual process exit. */
bool general_host_bootstrap_close(general_host_bootstrap **owner);
#endif
