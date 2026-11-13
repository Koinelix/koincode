#ifndef KOINCODE_GENERAL_CHANNEL_PEER_H
#define KOINCODE_GENERAL_CHANNEL_PEER_H
#include "session-installation.h"
#include <bsm/libbsm.h>

typedef struct general_channel_peer general_channel_peer;
typedef enum { GENERAL_CHANNEL_BROKER_HOST, GENERAL_CHANNEL_HOST_BROKER, GENERAL_CHANNEL_ROOT_BROKER, GENERAL_CHANNEL_BROKER_ROOT,
  GENERAL_CHANNEL_BROKER_PAYMENT_OWNER, GENERAL_CHANNEL_PAYMENT_OWNER_BROKER } general_channel_role;
/* These are fixed code and connection facts, not complete installation/profile,
 * child provenance, initialization, authentication or spending authority.
 * The original actor owns receipt/lease/scope validation and socket creation. */
bool general_channel_peer_open(int socket, general_channel_role role, const general_session_installation *receipt,
  bool (*current)(void *), void *context, general_channel_peer **out);
bool general_channel_peer_current(general_channel_peer *owner);
bool general_channel_peer_token(general_channel_peer *owner, audit_token_t *out);
bool general_channel_peer_role_current(general_channel_peer *owner, general_channel_role role);
/* A single IO loan lasts through real send/receive drain. Never close the fd. */
int general_channel_peer_borrow(general_channel_peer *owner);
bool general_channel_peer_return(general_channel_peer *owner);
/* Unknown close retains the owner to process exit and never retries. */
bool general_channel_peer_close(general_channel_peer **owner);
#endif
