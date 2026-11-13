#ifndef KOINCODE_GENERAL_SESSION_AUTH_H
#define KOINCODE_GENERAL_SESSION_AUTH_H
#import <Foundation/Foundation.h>
#include "session-request.h"
#include "initialization.h"

/* Fixed metadata only, never a native authentication/plan/window capability.
 * Export format uses its own action; parsing never grants transport authority. */
NSDictionary *general_parse_session_auth(NSData *data);
/* Operation accepts no reservation; initialization requires the original
 * frozen root reservation and an output record. Failure preserves output.
 * Actual peers, durable stages, restore plans and scopes remain actor-owned. */
NSDictionary *general_parse_session_begin_auth(const general_session_request *request, NSData *data,
  const general_initialization_plan *reservation, general_initialization_record *initialization);
#endif
