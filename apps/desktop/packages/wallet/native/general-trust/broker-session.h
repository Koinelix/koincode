#ifndef KOINCODE_GENERAL_BROKER_SESSION_H
#define KOINCODE_GENERAL_BROKER_SESSION_H
#import <Foundation/Foundation.h>
#include "host-launch.h"
#import "profile-authorization.h"
/* Actual broker connection, not a transport injected by Main. The enclosing
 * controller retains its namespace/profile/controlled child through close. */
@interface GeneralBrokerSession : NSObject
- (instancetype)initWithNamespace:(general_broker_namespace *)space profile:(GeneralProfileAuthorization *)profile
  launch:(general_host_launch *)launch mode:(general_host_mode)mode;
- (BOOL)start;
/* Call only for actual readable work or an in-flight authentication callback. */
- (BOOL)step;
- (BOOL)windowReady;
- (BOOL)pending;
- (BOOL)nativeWorkDrained;
/* Polling only, never a second transport reader or exported JS descriptor. */
- (int)descriptor;
/* Nonsecret point captured from two same-head inspection reads completed by
 * the sealed Host. The controller still proves actual successful reap before
 * publishing an inspection-only result; this never authorizes material IO. */
- (NSDictionary *)publicSnapshotCandidate;
/* Invalidation sequence only, never a profile, scope or source authority. */
- (uint64_t)publicStateRevision;
- (void)cancel;
/* Revokes first; no child reap or lock release is inferred from this return. */
- (BOOL)close;
@end
#endif
