#ifndef KOINCODE_GENERAL_MANAGEMENT_RECORD_POLICY_H
#define KOINCODE_GENERAL_MANAGEMENT_RECORD_POLICY_H
#import <Foundation/Foundation.h>
#include "native-head.h"
#include "initialization.h"

/* Pure public-metadata checks. Results are not authentication, an accepted
 * profile, a Keychain permit or authority to create a missing record. The real
 * broker actor supplies the original policy, matched prefix and DP bytes. */
NSDictionary *general_management_checkpoint(NSData *bytes, const general_native_identity *identity);
NSString *general_management_source_commitment(NSDictionary *source);
BOOL general_management_setup_scope(NSDictionary *auth, NSDictionary *state, NSDictionary *setup);
BOOL general_management_key_scope(NSDictionary *auth, NSDictionary *state, NSString *reference, BOOL writing);
BOOL general_management_state_advance(NSDictionary *auth, NSDictionary *before, NSDictionary *after);
BOOL general_management_initial_checkpoint(NSData *bytes, const general_initialization_record *initialization);
BOOL general_management_initial_registry(NSData *bytes, NSDictionary *initial_state, const general_initialization_record *initialization);
#endif
