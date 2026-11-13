#ifndef KOINCODE_GENERAL_SESSION_AUTHENTICATION_H
#define KOINCODE_GENERAL_SESSION_AUTHENTICATION_H
#import "authentication.h"
#include "session-guard.h"
#include "initialization.h"

/* Private main-thread native owner. Authentication facts only, never a key,
 * record, Add or signing capability. The actual actor retains all genuine
 * profile/peer/window/plan/DP gates through its base current callback.
 * Guard must outlive a successful close; never free it while policy drains. */
@interface GeneralSessionAuthentication : NSObject
- (instancetype)initWithBegin:(const general_session_request *)request value:(NSData *)value
  reservation:(const general_initialization_plan *)reservation guard:(general_session_guard *)guard
  current:(BOOL (^)(void))current completion:(void (^)(GeneralAuthResult result))completion;
/* Creates only a fresh real LAContext internally. NO if another actual policy
 * is still pending; no queue or reuse. The same valid owner may try start again
 * after that other policy actually drains, under the original begin deadline. */
- (BOOL)start;
- (void)cancel;
/* Current lifetime, not authentication. Invalidity revokes and cancels pending
 * evaluation, but never fabricates a system completion or guard drain. */
- (BOOL)current;
/* Current completed policy while the original begin is still pending. Only
 * the actual actor's frozen initialization/metadata stage may consume this
 * fact; it does not open the operation or allow material IO. */
- (BOOL)authenticatedBegin;
/* Only after the real policy approved and the original actor finished begin
 * OK. Still requires all command-specific gates in that actual actor. */
- (BOOL)authorized;
/* Exact currently borrowed original business slot, not a bearer auth result. */
- (BOOL)authorizesCommand:(const general_session_request *)request;
- (BOOL)drained;
/* Validated public auth metadata only. No proof/token or secret value. */
- (NSDictionary *)metadata;
/* Original public initialization metadata only; neither query proves a Root
 * reservation, durable phase, creation permission or authenticated plan IO. */
- (BOOL)initializationRecord:(general_initialization_record *)out;
- (BOOL)initializationOperationId:(char *)out capacity:(size_t)capacity;
- (BOOL)matchesInitializationPlan:(const general_initialization_plan *)plan;
/* Revoke first; returns NO until the actual policy and callback drain. */
- (BOOL)close;
@end
#endif
