#ifndef KOINCODE_GENERAL_PROFILE_AUTHORIZATION_H
#define KOINCODE_GENERAL_PROFILE_AUTHORIZATION_H
#import <Foundation/Foundation.h>
#include "broker-namespace.h"
/* Native factory only. Opens the one sealed profile and binds it to the
 * original actual broker/namespace. No caller bytes, path, certificate, Team,
 * entitlement, approved flag or independent Keychain group is accepted. */
@interface GeneralProfileAuthorization : NSObject
- (instancetype)initWithNamespace:(general_broker_namespace *)space;
- (BOOL)current;
/* Does not invalidate or release the namespace owned by the original actor. */
- (BOOL)close;
@end
#endif
