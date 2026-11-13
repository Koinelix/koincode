#include "broker-window.h"
#include "window-server.h"
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

struct general_broker_window {
  general_host_launch *launch; general_channel_peer *peer;
  audit_token_t token; uint32_t window_id; bool revoked, running, loan;
};
static atomic_flag occupied = ATOMIC_FLAG_INIT;
bool general_broker_window_current(general_broker_window *owner) {
  if (!owner || owner->revoked || owner->running) return false;
  owner->running = true; audit_token_t actual;
  bool valid = general_host_launch_current(owner->launch) && general_channel_peer_role_current(owner->peer, GENERAL_CHANNEL_BROKER_HOST) &&
    general_channel_peer_token(owner->peer, &actual) && !memcmp(&actual, &owner->token, sizeof(actual)) &&
    general_window_server_matches(owner->window_id, audit_token_to_pid(owner->token)) && general_host_launch_current(owner->launch) &&
    general_channel_peer_token(owner->peer, &actual) && !memcmp(&actual, &owner->token, sizeof(actual));
  owner->running = false; if (!valid) owner->revoked = true; return valid;
}
bool general_broker_window_open(general_host_launch *launch, uint32_t window_id, general_broker_window **out) {
  if (!launch || !window_id || !out || *out || !general_host_launch_current(launch) || atomic_flag_test_and_set(&occupied)) return false;
  general_broker_window *owner = calloc(1, sizeof(*owner));
  if (!owner) { atomic_flag_clear(&occupied); return false; }
  owner->launch = launch; owner->window_id = window_id;
  owner->peer = general_host_launch_borrow_window(launch); owner->loan = owner->peer != NULL;
  if (!owner->peer || !general_channel_peer_token(owner->peer, &owner->token) || !general_broker_window_current(owner)) {
    if (!general_broker_window_close(&owner)) *out = owner; return false;
  }
  *out = owner; return true;
}
void general_broker_window_invalidate(general_broker_window *owner) { if (owner) owner->revoked = true; }
bool general_broker_window_close(general_broker_window **pointer) {
  if (!pointer || !*pointer) return true;
  general_broker_window *owner = *pointer; if (owner->running) return false;
  owner->revoked = true;
  if (owner->loan && !general_host_launch_return_window(owner->launch)) return false;
  free(owner); *pointer = NULL; atomic_flag_clear(&occupied); return true;
}
