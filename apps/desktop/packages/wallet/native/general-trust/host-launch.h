#ifndef KOINCODE_GENERAL_HOST_LAUNCH_H
#define KOINCODE_GENERAL_HOST_LAUNCH_H
#include "broker-namespace.h"
#include "host-bootstrap-wire.h"
#include "channel-peer.h"
typedef struct general_host_launch general_host_launch;
typedef enum { GENERAL_HOST_LAUNCH_UNAVAILABLE, GENERAL_HOST_LAUNCH_BUSY, GENERAL_HOST_LAUNCH_READY,
  GENERAL_HOST_LAUNCH_UNCERTAIN } general_host_launch_result;
/* Actual broker only, under its original namespace/installation/UID owner loan.
 * Creates one private rendezvous and its original fixed, controlled child.
 * No public caller path, argv, environment, child PID or nonce is accepted.
 * A live child is still not a window, scope, profile or secret capability. */
general_host_launch_result general_host_launch_open(general_broker_namespace *space, general_host_mode mode,
  bool (*current)(void *), void *context, general_host_launch **out);
bool general_host_launch_current(general_host_launch *owner);
/* Native actor only, exclusive channel IO loan through actual completion. */
general_channel_peer *general_host_launch_borrow(general_host_launch *owner);
bool general_host_launch_return(general_host_launch *owner);
/* Separate lifetime loan for the native window observer, not channel IO.
 * The original transport actor may retain its own exclusive IO loan. */
general_channel_peer *general_host_launch_borrow_window(general_host_launch *owner);
bool general_host_launch_return_window(general_host_launch *owner);
/* Revokes first; only signals the same unreaped original child. No fake reap. */
void general_host_launch_cancel(general_host_launch *owner);
/* Polling is by the current bounded control/cleanup operation, never idle work.
 * False retains the original process/namespace/locks for actual drain. */
bool general_host_launch_reaped(general_host_launch *owner);
/* Original waitpid status only. Absence, signal, failed or unrelated child
 * cannot publish a completed inspection's public result. */
bool general_host_launch_exit_success(general_host_launch *owner);
/* Actual original child reap and the same retained peer object, even after
 * window/transport revocation. No caller PID, token copy or boolean proof. */
bool general_host_launch_reaped_peer(general_host_launch *owner, general_channel_peer *peer);
bool general_host_launch_close(general_host_launch **owner);
#endif
