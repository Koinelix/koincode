#ifndef KOINCODE_GENERAL_HEAD_INITIALIZATION_H
#define KOINCODE_GENERAL_HEAD_INITIALIZATION_H
#import "session-authentication.h"
#include "broker-namespace.h"
#include "enrollment-client.h"
#include "native-journal-connection.h"
#include "native-directory.h"

typedef NS_ENUM(NSUInteger, GeneralHeadPreparation) {
  GeneralHeadRejected, GeneralHeadUncertain, GeneralHeadCreated, GeneralHeadExisting
};
typedef NS_ENUM(NSUInteger, GeneralInitializationPublication) {
  GeneralInitializationRejected, GeneralInitializationUncertain, GeneralInitializationPrepared, GeneralInitializationAssigned
};
/* Private serialized metadata stage only. The actor retains namespace/guard and
 * the same Root client across bootstrap, initialization and final assignment.
 * Profile, original Host/window and all other genuine actor gates remain in
 * current; it must not recursively call this object or the Root client.
 * Created/existing do not prove initialized records, accepted journal prefix,
 * assignment, ready, material access or signing authority. */
@interface GeneralHeadInitialization : NSObject
- (instancetype)initWithNamespace:(general_broker_namespace *)space client:(general_enrollment_client *)client
  authentication:(GeneralSessionAuthentication *)authentication plan:(const general_initialization_plan *)plan current:(BOOL (^)(void))current;
/* Exactly one attempt. Output unchanged unless actual created/existing head is
 * verified. This never sends assign, updates/deletes a head or reconnects. */
- (GeneralHeadPreparation)prepareHead:(general_native_head *)out;
/* One attempt only after this same owner actually created and read back genesis.
 * The actor supplies its verified fixed native-directory fd and retains it and
 * the returned connection. Existing heads never authorize this constructor.
 * This owner borrows it until close; the actor must retain its actual owner.
 * Physical READY is not wallet/assignment/prefix readiness or material access. */
- (general_native_journal_initialization)createNativeJournalAtDirectory:(int)directory owner:(general_native_journal_connection **)out;
/* Explicit reauthenticated original initialization only after actual Existing.
 * Opens only the fixed existing journal; never creates missing files. */
- (general_native_journal_initialization)openExistingNativeJournalAtDirectory:(int)directory owner:(general_native_journal_connection **)out;
/* Production physical namespace path. Derives only from the actual console
 * home and original plan; creates only after this owner's actual genesis Add.
 * Existing heads never create directories. No path or fresh claim input. */
- (general_native_journal_initialization)openNativeJournalInFixedNamespace:(general_native_journal_connection **)out;
/* Uses only the original frozen prepared record and this owner's original
 * retained journal loan. Outputs remain unchanged on failure. No material IO. */
- (GeneralInitializationPublication)prepareInitializationRecord:(general_initialization_record *)record head:(general_native_head *)head;
/* Original prepared bytes/operation only. Never retries target IO after any
 * write_started evidence; exact existing bytes may only finish metadata. */
- (GeneralInitializationPublication)resumePreparedInitializationRecord:(general_initialization_record *)record head:(general_native_head *)head;
/* Revalidates actual prepared DP/journal facts before one original assign.
 * Success is enrollment only, never target/ready/signing authority. */
- (GeneralInitializationPublication)assignPreparedInitialization;
/* Genuine broker connection only, after this exact owner's actual assign.
 * Transfers the existing physical owners once; never reopens or creates files.
 * The receiving native lifetime is connection/namespace/peer/window current,
 * not a portable auth result. Every later command needs its own native scope.
 * Outputs must be empty; unknown transfer retains this owner for process reap. */
- (BOOL)transferPreparedResourcesToDirectory:(general_native_directory **)directory
  journal:(general_native_journal_connection **)journal current:(bool (*)(void *))current context:(void *)context;
/* Only a cancellation latch; cannot interrupt or pretend a live OS IO drained. */
- (void)cancel;
/* Refuses running IO; returns original journal/client loans, never closes them. */
- (BOOL)close;
@end
#endif
