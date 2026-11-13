#ifndef KOINCODE_GENERAL_MANAGEMENT_RECORDS_H
#define KOINCODE_GENERAL_MANAGEMENT_RECORDS_H
#import "session-authentication.h"
#include "profile-view.h"
#include "native-record.h"
#include "resource-session.h"

typedef enum { GENERAL_MANAGEMENT_WRITE_REJECTED, GENERAL_MANAGEMENT_WRITE_UNCERTAIN,
  GENERAL_MANAGEMENT_WRITE_COMMITTED, GENERAL_MANAGEMENT_WRITE_IDENTICAL } general_management_write_result;

/* Native-private basic management actor. The original view, journal, broker
 * namespace, UID lease, peer and window must outlive successful close. No path,
 * identity, profile, LAContext, permit boolean or caller SQL is accepted here.
 * The connection actor lends its actual original authenticated command; this
 * actor independently binds that policy to accepted DP state and source. */
@interface GeneralManagementRecords : NSObject
- (instancetype)initWithView:(general_profile_view *)view journal:(general_native_journal_connection *)journal
  current:(BOOL (^)(void))current;
/* The actual original resource session is mandatory for first publication. */
- (instancetype)initWithView:(general_profile_view *)view journal:(general_native_journal_connection *)journal
  resources:(general_resource_session *)resources current:(BOOL (^)(void))current;
- (general_native_record_status)read:(const general_session_request *)request
  authentication:(GeneralSessionAuthentication *)authentication output:(general_native_record_bytes *)out;
- (general_management_write_result)write:(const general_session_request *)request value:(NSData *)value
  authentication:(GeneralSessionAuthentication *)authentication;
/* Unknown mutations retain the physical journal loan for broker reaping. */
- (BOOL)close;
@end
#endif
