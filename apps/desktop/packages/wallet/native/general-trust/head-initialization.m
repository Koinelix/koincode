#import "head-initialization.h"
#import <LocalAuthentication/LocalAuthentication.h>
#include "native-anchor.h"
#include "native-journal-append.h"
#include "native-directory.h"
#include "enrollment-payload.h"
#include <CommonCrypto/CommonDigest.h>
#include <Security/Security.h>
#include <objc/runtime.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

static bool elapsed(struct timespec *last, const struct timespec *start, unsigned seconds) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) || now.tv_sec < 0 || now.tv_nsec < 0 || now.tv_nsec >= 1000000000 || now.tv_sec < last->tv_sec ||
      (now.tv_sec == last->tv_sec && now.tv_nsec < last->tv_nsec) || now.tv_sec < start->tv_sec || now.tv_sec - start->tv_sec > seconds ||
      (now.tv_sec - start->tv_sec == seconds && now.tv_nsec >= start->tv_nsec)) return false;
  *last = now; return true;
}
static bool same_head(const general_native_head *a, const general_native_head *b) {
  return general_native_head_same_identity(a, &b->identity) && a->sequence == b->sequence && !strcmp(a->head_digest, b->head_digest);
}
@interface GeneralHeadInitialization ()
- (BOOL)resourcesCurrent;
- (BOOL)directoryBaseCurrent;
- (BOOL)current;
- (BOOL)startedCurrent;
- (BOOL)registeredCurrent;
@end
typedef struct { __unsafe_unretained GeneralHeadInitialization *owner; struct timespec started, last; bool creating, registered; general_native_journal_connection *journal; } head_io;
static bool root_current(void *context) { return [(__bridge GeneralHeadInitialization *)context resourcesCurrent]; }
static bool directory_current(void *context) { return [(__bridge GeneralHeadInitialization *)context directoryBaseCurrent]; }
static bool io_current(void *context) {
  head_io *op = context;
  return elapsed(&op->last, &op->started, 30) && [op->owner current] && (!op->creating || [op->owner startedCurrent]) &&
    (!op->registered || [op->owner registeredCurrent]) &&
    (!op->journal || general_native_journal_connection_current(op->journal)) && elapsed(&op->last, &op->started, 30);
}
static bool begin_io(GeneralHeadInitialization *owner, bool creating, head_io *op) {
  *op = (head_io){ .owner = owner, .creating = creating };
  if (clock_gettime(CLOCK_MONOTONIC, &op->started)) return false;
  op->last = op->started; return io_current(op);
}
static CFMutableDictionaryRef initialization_query(const general_native_identity *identity, const general_session_installation *installation, LAContext *context) {
  char account[100]; int count = snprintf(account, sizeof(account), "e:%s:general-initialization-v1", identity->enrollment_id);
  if (count < 1 || count >= (int)sizeof(account)) return NULL;
  CFStringRef name = CFStringCreateWithCString(NULL, account, kCFStringEncodingUTF8);
  CFStringRef group = CFStringCreateWithCString(NULL, installation->keychain_access_group, kCFStringEncodingUTF8);
  CFMutableDictionaryRef query = name && group ? CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks) : NULL;
  if (query) {
    CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
    CFDictionarySetValue(query, kSecUseDataProtectionKeychain, kCFBooleanTrue);
    CFDictionarySetValue(query, kSecAttrService, CFSTR("dev.koincode.wallet.general.protected.v1"));
    CFDictionarySetValue(query, kSecAttrAccount, name); CFDictionarySetValue(query, kSecAttrAccessGroup, group);
    CFDictionarySetValue(query, kSecAttrAccessible, kSecAttrAccessibleWhenUnlockedThisDeviceOnly);
    CFDictionarySetValue(query, kSecAttrSynchronizable, kCFBooleanFalse);
    CFDictionarySetValue(query, kSecUseAuthenticationContext, (__bridge CFTypeRef)context);
    CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);
    CFDictionarySetValue(query, kSecReturnAttributes, kCFBooleanTrue); CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue);
  }
  if (name) CFRelease(name); if (group) CFRelease(group); return query;
}
static bool record_bytes(const general_initialization_record *record, CFDataRef *out, char digest[65]) {
  unsigned char bytes[GENERAL_NATIVE_INITIALIZATION_MAX], hash[CC_SHA256_DIGEST_LENGTH]; size_t size;
  if (!general_initialization_record_encode(record, bytes, sizeof(bytes), &size) || !CC_SHA256(bytes, (CC_LONG)size, hash)) return false;
  static const char hex[] = "0123456789abcdef";
  for (unsigned i = 0; i < sizeof(hash); i++) { digest[i * 2] = hex[hash[i] >> 4]; digest[i * 2 + 1] = hex[hash[i] & 15]; }
  digest[64] = 0; *out = CFDataCreate(NULL, bytes, (CFIndex)size); return *out != NULL;
}
static general_native_anchor_status read_initialization(CFDictionaryRef query, CFDataRef expected, head_io *op) {
  if (!query || !expected || !io_current(op)) return GENERAL_NATIVE_ANCHOR_UNAVAILABLE;
  CFTypeRef result = NULL; OSStatus status = SecItemCopyMatching(query, &result);
  general_native_anchor_status outcome = GENERAL_NATIVE_ANCHOR_UNAVAILABLE;
  if (io_current(op)) {
    if (status == errSecItemNotFound && !result) outcome = GENERAL_NATIVE_ANCHOR_MISSING;
    else if (status == errSecSuccess) {
      outcome = GENERAL_NATIVE_ANCHOR_INVALID;
      if (result && CFGetTypeID(result) == CFDictionaryGetTypeID()) {
        CFDictionaryRef record = (CFDictionaryRef)result;
        CFStringRef keys[] = { kSecAttrAccount, kSecAttrService, kSecAttrAccessGroup, kSecAttrAccessible };
        bool same = true;
        for (unsigned i = 0; i < sizeof(keys) / sizeof(keys[0]); i++) {
          CFTypeRef actual = CFDictionaryGetValue(record, keys[i]);
          if (!actual || !CFEqual(actual, CFDictionaryGetValue(query, keys[i]))) same = false;
        }
        CFTypeRef sync = CFDictionaryGetValue(record, kSecAttrSynchronizable), value = CFDictionaryGetValue(record, kSecValueData);
        if (sync && (CFGetTypeID(sync) != CFBooleanGetTypeID() || !CFEqual(sync, kCFBooleanFalse))) same = false;
        if (same && value && CFGetTypeID(value) == CFDataGetTypeID() && CFDataGetLength(value) > 0 &&
            CFDataGetLength(value) <= GENERAL_NATIVE_INITIALIZATION_MAX && CFEqual(value, expected)) outcome = GENERAL_NATIVE_ANCHOR_FOUND;
      }
    }
  }
  if (result) CFRelease(result); return io_current(op) ? outcome : GENERAL_NATIVE_ANCHOR_UNAVAILABLE;
}
static bool append_initialization(head_io *op, general_native_head *head, general_native_event *event, general_native_stage stage,
    const general_session_installation *installation) {
  if (!io_current(op)) return false;
  event->sequence = head->sequence + 1; memcpy(event->previous_digest, head->head_digest, 65); event->stage = stage;
  if (general_native_journal_append(general_native_journal_connection_database(op->journal), head, event, installation, NULL, io_current, op) != GENERAL_NATIVE_APPEND_ANCHORED)
    return false;
  general_native_head next = *head; next.sequence = event->sequence;
  if (!general_native_event_digest(event, next.head_digest) || !io_current(op)) return false;
  *head = next; return true;
}
static bool add_prepared(CFDictionaryRef query, CFDataRef bytes, head_io *op) {
  CFMutableDictionaryRef attributes = CFDictionaryCreateMutableCopy(NULL, 0, query);
  if (!attributes) return false;
  CFDictionaryRemoveValue(attributes, kSecMatchLimit); CFDictionaryRemoveValue(attributes, kSecReturnAttributes); CFDictionaryRemoveValue(attributes, kSecReturnData);
  CFDictionarySetValue(attributes, kSecValueData, bytes);
  bool ok = io_current(op) && SecItemAdd(attributes, NULL) == errSecSuccess && io_current(op) &&
    read_initialization(query, bytes, op) == GENERAL_NATIVE_ANCHOR_FOUND;
  CFRelease(attributes); return ok;
}
static bool original_initialization_event(const general_native_event *event, const char *operation, const char *plan, const char *next) {
  return !strcmp(event->reference, "general-initialization-v1") && !strcmp(event->operation_id, operation) &&
    !strcmp(event->operation_digest, plan) && !event->has_expected && !strcmp(event->next_digest, next);
}
@implementation GeneralHeadInitialization {
  general_broker_namespace *_space;
  general_enrollment_client *_client;
  GeneralSessionAuthentication *_authentication;
  general_initialization_plan _plan;
  general_initialization_record _record;
  general_session_installation _installation;
  general_enrollment_hello _hello;
  general_native_journal_connection *_journal;
  general_native_directory *_directory;
  BOOL _directoryAttempted, _directoryLoan;
  BOOL _assignedHere, _transferAttempted, _resourcesTransferred;
  general_native_head _preparedHead;
  general_native_head _existingHead;
  char _operationId[37];
  struct timespec _started, _last;
  BOOL (^_baseCurrent)(void);
  _Atomic(bool) _canceled;
  BOOL _loan, _closed, _running, _attempted, _checking, _creationConsumed, _createdHere, _existingHere, _journalAttempted, _recordAttempted, _recordPrepared, _assignAttempted;
}
- (instancetype)initWithNamespace:(general_broker_namespace *)space client:(general_enrollment_client *)client
  authentication:(GeneralSessionAuthentication *)authentication plan:(const general_initialization_plan *)plan current:(BOOL (^)(void))current {
  if (!(self = [super init])) return nil;
  if (!NSThread.isMainThread || !space || !client || object_getClass(authentication) != GeneralSessionAuthentication.class || !current ||
      !general_initialization_plan_valid(plan) || ![authentication matchesInitializationPlan:plan] || !authentication.authenticatedBegin ||
      ![authentication initializationRecord:&_record] || ![authentication initializationOperationId:_operationId capacity:sizeof(_operationId)]) return nil;
  _space = space; _client = client; _authentication = authentication; _plan = *plan; _baseCurrent = [current copy]; atomic_init(&_canceled, false);
  if (clock_gettime(CLOCK_MONOTONIC, &_started)) return nil;
  _last = _started; general_console_identity console;
  if (!general_broker_namespace_info(space, &console, &_installation) || console.uid != plan->identity.uid ||
      strcmp(_installation.installation_id, plan->identity.installation_id) || !general_enrollment_client_hello(client, &_hello) ||
      !general_enrollment_client_borrow(client)) return nil;
  _loan = YES;
  if (![self current]) { [self close]; return nil; }
  return self;
}
- (BOOL)resourcesCurrent {
  if (!NSThread.isMainThread || _closed || atomic_load(&_canceled) || _checking || !_baseCurrent) return NO;
  _checking = YES;
  BOOL valid = elapsed(&_last, &_started, 360) && _baseCurrent() && [_authentication matchesInitializationPlan:&_plan] &&
    _authentication.authenticatedBegin && general_broker_namespace_current(_space) && elapsed(&_last, &_started, 360) && !atomic_load(&_canceled);
  _checking = NO;
  if (!valid) atomic_store(&_canceled, true);
  return valid;
}
- (BOOL)directoryBaseCurrent {
  general_enrollment_hello hello;
  return [self resourcesCurrent] && general_enrollment_client_hello(_client, &hello) && hello.uid == _hello.uid &&
    hello.receipt_revision == _hello.receipt_revision && hello.preparation == _hello.preparation && !strcmp(hello.installation_id, _hello.installation_id) && [self resourcesCurrent];
}
- (BOOL)current { return [self directoryBaseCurrent] && (!_directoryLoan || general_native_directory_current(_directory)); }
- (BOOL)inspect:(general_registration_view *)view {
  return [self current] && general_broker_namespace_inspect(_space, view) && [self current] && view->registration_present &&
    general_registration_binding_valid(&view->registration, &_plan);
}
- (BOOL)startedCurrent {
  general_registration_view view;
  return [self inspect:&view] && !view.assignment_present && view.registration.phase == GENERAL_REGISTRATION_HEAD_CREATE_STARTED;
}
- (BOOL)registeredCurrent {
  general_registration_view view;
  return [self inspect:&view] && (view.registration.phase == GENERAL_REGISTRATION_HEAD_CREATE_STARTED ||
    (view.registration.phase == GENERAL_REGISTRATION_ASSIGNED && view.assignment_present));
}
- (general_native_anchor_status)readHead:(general_native_head *)head {
  head_io op;
  if (!begin_io(self, false, &op)) return GENERAL_NATIVE_ANCHOR_UNAVAILABLE;
  return general_native_anchor_read(&_plan.identity, &_installation, io_current, &op, head);
}
- (BOOL)send:(general_enrollment_command)command value:(const unsigned char *)value size:(size_t)size {
  general_enrollment_request request = { .command = command };
  NSString *identifier = NSUUID.UUID.UUIDString.lowercaseString;
  if (!identifier || identifier.length != 36) return NO;
  memcpy(request.request_id, identifier.UTF8String, 37);
  return [self current] && general_enrollment_client_request_scoped(_client, &request, value, size, root_current, (__bridge void *)self) == GENERAL_ENROLLMENT_CLIENT_READY && [self current];
}
- (GeneralHeadPreparation)createHead:(general_native_head *)out {
  if (_creationConsumed) return GeneralHeadUncertain;
  _creationConsumed = YES; head_io op;
  if (!begin_io(self, true, &op)) return GeneralHeadUncertain;
  general_native_head actual;
  if (general_native_anchor_read(&_plan.identity, &_installation, io_current, &op, &actual) != GENERAL_NATIVE_ANCHOR_MISSING) return GeneralHeadUncertain;
  general_native_head genesis = { .identity = _plan.identity, .sequence = 0 }; unsigned char bytes[GENERAL_NATIVE_HEAD_MAX]; size_t size;
  if (!general_native_genesis_digest(&_plan.identity, genesis.head_digest) || !general_native_head_encode(&genesis, bytes, sizeof(bytes), &size)) return GeneralHeadUncertain;
  char account[80]; int length = snprintf(account, sizeof(account), "e:%s:native-head-v1", _plan.identity.enrollment_id);
  if (length < 1 || length >= (int)sizeof(account)) return GeneralHeadUncertain;
  CFStringRef name = CFStringCreateWithCString(NULL, account, kCFStringEncodingUTF8);
  CFStringRef group = CFStringCreateWithCString(NULL, _installation.keychain_access_group, kCFStringEncodingUTF8);
  CFDataRef value = CFDataCreate(NULL, bytes, (CFIndex)size);
  LAContext *context = [LAContext new]; context.interactionNotAllowed = YES;
  CFMutableDictionaryRef attributes = name && group && value && context ? CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks) : NULL;
  GeneralHeadPreparation result = GeneralHeadUncertain;
  if (attributes) {
    CFDictionarySetValue(attributes, kSecClass, kSecClassGenericPassword);
    CFDictionarySetValue(attributes, kSecUseDataProtectionKeychain, kCFBooleanTrue);
    CFDictionarySetValue(attributes, kSecAttrService, CFSTR("dev.koincode.wallet.general.protected.v1"));
    CFDictionarySetValue(attributes, kSecAttrAccessGroup, group);
    CFDictionarySetValue(attributes, kSecAttrAccount, name);
    CFDictionarySetValue(attributes, kSecAttrSynchronizable, kCFBooleanFalse);
    CFDictionarySetValue(attributes, kSecAttrAccessible, kSecAttrAccessibleWhenUnlockedThisDeviceOnly);
    CFDictionarySetValue(attributes, kSecUseAuthenticationContext, (__bridge CFTypeRef)context);
    CFDictionarySetValue(attributes, kSecValueData, value);
    if (io_current(&op)) {
      /* This is the only genesis Add site. No error permits retry. */
      OSStatus status = SecItemAdd(attributes, NULL);
      if (status == errSecSuccess && io_current(&op) &&
          general_native_anchor_read(&_plan.identity, &_installation, io_current, &op, &actual) == GENERAL_NATIVE_ANCHOR_FOUND &&
          same_head(&actual, &genesis) && io_current(&op)) { *out = actual; result = GeneralHeadCreated; }
    }
  }
  [context invalidate];
  if (attributes) CFRelease(attributes); if (name) CFRelease(name); if (group) CFRelease(group); if (value) CFRelease(value);
  if (result == GeneralHeadCreated && !io_current(&op)) result = GeneralHeadUncertain;
  return result;
}
- (GeneralHeadPreparation)prepareHead:(general_native_head *)out {
  if (!NSThread.isMainThread || !out || _closed || _running || _attempted) return GeneralHeadRejected;
  _attempted = _running = YES; GeneralHeadPreparation result = GeneralHeadRejected; general_native_head head, actual;
  general_registration_view before, view; unsigned char bytes[GENERAL_NATIVE_INITIALIZATION_MAX]; size_t size;
  if (![self current] || !general_broker_namespace_inspect(_space, &before) || ![self current]) goto done;
  BOOL fresh = _hello.preparation == GENERAL_ENROLLMENT_FRESH;
  if (fresh ? before.registration_present || before.assignment_present : !before.registration_present || !general_registration_binding_valid(&before.registration, &_plan)) goto done;
  general_registration_phase original = fresh ? GENERAL_REGISTRATION_RESERVED : before.registration.phase;
  BOOL first = original == GENERAL_REGISTRATION_RESERVED;
  if (first && (_record.phase != GENERAL_INITIALIZATION_PREPARED || before.assignment_present)) goto done;
  general_native_anchor_status status = [self readHead:&head];
  if ((first && status != GENERAL_NATIVE_ANCHOR_MISSING) || (!first && status != GENERAL_NATIVE_ANCHOR_FOUND)) { result = GeneralHeadUncertain; goto done; }
  result = GeneralHeadUncertain;
  if (!general_initialization_plan_encode(&_plan, bytes, sizeof(bytes), &size) || ![self send:GENERAL_ENROLLMENT_RESERVE value:bytes size:size] ||
      ![self inspect:&view] || view.registration.phase != original || view.assignment_present != before.assignment_present ||
      ![self send:GENERAL_ENROLLMENT_START_HEAD value:NULL size:0] || ![self inspect:&view] ||
      view.registration.phase != (first ? GENERAL_REGISTRATION_HEAD_CREATE_STARTED : original) || view.assignment_present != before.assignment_present) goto done;
  if (first) result = [self createHead:&actual];
  else if ([self readHead:&actual] == GENERAL_NATIVE_ANCHOR_FOUND && same_head(&head, &actual) && [self current]) result = GeneralHeadExisting;
  if ((result == GeneralHeadCreated || result == GeneralHeadExisting) && [self current]) *out = actual;
  else if (result == GeneralHeadCreated || result == GeneralHeadExisting) result = GeneralHeadUncertain;
done:
  _createdHere = result == GeneralHeadCreated;
  _existingHere = result == GeneralHeadExisting;
  if (_existingHere) _existingHead = actual;
  _running = NO; return result;
}
- (general_native_journal_initialization)createNativeJournalAtDirectory:(int)directory owner:(general_native_journal_connection **)out {
  if (!NSThread.isMainThread || !out || *out || directory < 0 || _closed || _running || !_createdHere || _journalAttempted)
    return GENERAL_NATIVE_INITIALIZATION_REJECTED;
  _journalAttempted = _running = YES;
  general_native_journal_initialization result = GENERAL_NATIVE_INITIALIZATION_UNCERTAIN;
  general_native_head actual, genesis = { .identity = _plan.identity, .sequence = 0 }; head_io op;
  if (_record.phase == GENERAL_INITIALIZATION_PREPARED && begin_io(self, true, &op) &&
      general_native_genesis_digest(&_plan.identity, genesis.head_digest) &&
      general_native_anchor_read(&_plan.identity, &_installation, io_current, &op, &actual) == GENERAL_NATIVE_ANCHOR_FOUND &&
      same_head(&actual, &genesis) && io_current(&op))
    result = general_native_journal_connection_initialize(directory, io_current, &op, out);
  if (result == GENERAL_NATIVE_INITIALIZATION_READY) {
    if (general_native_journal_connection_borrow(*out)) _journal = *out;
    else result = GENERAL_NATIVE_INITIALIZATION_UNCERTAIN;
  }
  if (result != GENERAL_NATIVE_INITIALIZATION_READY) atomic_store(&_canceled, true);
  _running = NO; return result;
}
- (general_native_journal_initialization)openNativeJournalInFixedNamespace:(general_native_journal_connection **)out {
  if (!NSThread.isMainThread || !out || *out || _closed || _running || _directoryAttempted || _journalAttempted || (!_createdHere && !_existingHere))
    return GENERAL_NATIVE_INITIALIZATION_REJECTED;
  _directoryAttempted = _running = YES;
  general_native_journal_initialization result = GENERAL_NATIVE_INITIALIZATION_UNCERTAIN;
  general_native_head actual, expected = { .identity = _plan.identity, .sequence = 0 }; head_io op;
  if (_record.phase != GENERAL_INITIALIZATION_PREPARED || !begin_io(self, _createdHere, &op)) goto done;
  op.registered = _existingHere;
  if (!io_current(&op) || !general_native_genesis_digest(&_plan.identity, expected.head_digest) ||
      general_native_anchor_read(&_plan.identity, &_installation, io_current, &op, &actual) != GENERAL_NATIVE_ANCHOR_FOUND ||
      !same_head(&actual, _createdHere ? &expected : &_existingHead) || !io_current(&op)) goto done;
  /* The retained directory uses the owner's persistent base lifetime, not the
   * temporary IO frame. Check this original phase/budget on both sides. */
  if (general_native_directory_open(&_plan.identity, _createdHere, directory_current, (__bridge void *)self, &_directory) != GENERAL_NATIVE_DIRECTORY_READY || !io_current(&op)) goto done;
  int directory;
  if (!general_native_directory_borrow(_directory, &directory)) goto done;
  _directoryLoan = YES;
  _running = NO;
  result = _createdHere ? [self createNativeJournalAtDirectory:directory owner:out] : [self openExistingNativeJournalAtDirectory:directory owner:out];
done:
  if (result != GENERAL_NATIVE_INITIALIZATION_READY) { _journalAttempted = YES; atomic_store(&_canceled, true); }
  _running = NO; return result;
}
- (general_native_journal_initialization)openExistingNativeJournalAtDirectory:(int)directory owner:(general_native_journal_connection **)out {
  if (!NSThread.isMainThread || !out || *out || directory < 0 || _closed || _running || !_existingHere || _journalAttempted)
    return GENERAL_NATIVE_INITIALIZATION_REJECTED;
  _journalAttempted = _running = YES; general_native_journal_initialization result = GENERAL_NATIVE_INITIALIZATION_UNCERTAIN;
  head_io op; general_native_head actual;
  if (_record.phase != GENERAL_INITIALIZATION_PREPARED || !begin_io(self, false, &op)) goto done;
  op.registered = true;
  if (!io_current(&op) || general_native_anchor_read(&_plan.identity, &_installation, io_current, &op, &actual) != GENERAL_NATIVE_ANCHOR_FOUND || !same_head(&actual, &_existingHead)) goto done;
  *out = general_native_journal_connection_create(directory);
  if (!*out || !general_native_journal_connection_open(*out, io_current, &op) || !io_current(&op) || !general_native_journal_connection_borrow(*out)) goto done;
  _journal = *out; result = GENERAL_NATIVE_INITIALIZATION_READY;
done:
  if (result != GENERAL_NATIVE_INITIALIZATION_READY) atomic_store(&_canceled, true);
  _running = NO; return result;
}
- (GeneralInitializationPublication)prepareInitializationRecord:(general_initialization_record *)record head:(general_native_head *)head {
  if (!NSThread.isMainThread || !record || !head || _closed || _running || !_createdHere || !_journal || _recordAttempted) return GeneralInitializationRejected;
  _recordAttempted = _running = YES; GeneralInitializationPublication result = GeneralInitializationUncertain;
  head_io op; general_native_head actual, genesis = { .identity = _plan.identity, .sequence = 0 };
  general_native_replay *replay = NULL; CFDataRef bytes = NULL; CFMutableDictionaryRef query = NULL;
  LAContext *context = [LAContext new]; context.interactionNotAllowed = YES;
  general_native_event event = { .has_expected = false };
  if (_record.phase != GENERAL_INITIALIZATION_PREPARED || !begin_io(self, true, &op)) goto done;
  op.journal = _journal;
  if (!context || !io_current(&op) || !general_native_genesis_digest(&_plan.identity, genesis.head_digest) ||
      general_native_anchor_read(&_plan.identity, &_installation, io_current, &op, &actual) != GENERAL_NATIVE_ANCHOR_FOUND || !same_head(&actual, &genesis)) goto done;
  replay = general_native_journal_inspect(_journal, &actual, NULL, io_current, &op);
  if (!replay || general_native_replay_seal(replay) != GENERAL_NATIVE_REPLAY_MATCHED || !io_current(&op)) goto done;
  general_native_replay_destroy(&replay);
  if (!record_bytes(&_record, &bytes, event.next_digest)) goto done;
  query = initialization_query(&_plan.identity, &_installation, context);
  if (read_initialization(query, bytes, &op) != GENERAL_NATIVE_ANCHOR_MISSING) goto done;
  memcpy(event.operation_id, _operationId, sizeof(event.operation_id));
  memcpy(event.operation_digest, _plan.identity.initialization_digest, sizeof(event.operation_digest));
  memcpy(event.reference, "general-initialization-v1", sizeof("general-initialization-v1"));
  if (!append_initialization(&op, &actual, &event, GENERAL_NATIVE_ADMITTED, &_installation) ||
      !append_initialization(&op, &actual, &event, GENERAL_NATIVE_WRITE_STARTED, &_installation)) goto done;
  if (!add_prepared(query, bytes, &op) ||
      !append_initialization(&op, &actual, &event, GENERAL_NATIVE_COMMITTED, &_installation) || !io_current(&op)) goto done;
  _preparedHead = actual; _recordPrepared = YES; *record = _record; *head = actual; result = GeneralInitializationPrepared;
done:
  general_native_replay_destroy(&replay); [context invalidate];
  if (query) CFRelease(query); if (bytes) CFRelease(bytes);
  if (result != GeneralInitializationPrepared) atomic_store(&_canceled, true);
  _running = NO; return result;
}
- (GeneralInitializationPublication)resumePreparedInitializationRecord:(general_initialization_record *)record head:(general_native_head *)head {
  if (!NSThread.isMainThread || !record || !head || _closed || _running || !_existingHere || !_journal || _recordAttempted) return GeneralInitializationRejected;
  _recordAttempted = _running = YES; GeneralInitializationPublication result = GeneralInitializationUncertain;
  head_io op; general_native_head actual; general_native_ref_state state = {0}; general_native_event event = {0}, tail;
  general_native_replay *replay = NULL; CFDataRef bytes = NULL; CFMutableDictionaryRef query = NULL;
  char next[65], tailDigest[65]; general_native_anchor_status target;
  general_native_ref_presence presence; general_native_replay_status prefix;
  LAContext *context = [LAContext new]; context.interactionNotAllowed = YES;
  if (!context || _record.phase != GENERAL_INITIALIZATION_PREPARED || !begin_io(self, false, &op)) goto done;
  op.registered = true; op.journal = _journal;
  if (!io_current(&op) || general_native_anchor_read(&_plan.identity, &_installation, io_current, &op, &actual) != GENERAL_NATIVE_ANCHOR_FOUND ||
      !same_head(&actual, &_existingHead) || !record_bytes(&_record, &bytes, next)) goto done;
  replay = general_native_journal_inspect(_journal, &actual, NULL, io_current, &op);
  if (!replay || !io_current(&op)) goto done;
  prefix = general_native_replay_seal(replay);
  presence = general_native_replay_lookup(replay, NULL, "general-initialization-v1", &state);
  if ((prefix != GENERAL_NATIVE_REPLAY_MATCHED && prefix != GENERAL_NATIVE_REPLAY_TAIL) || presence == GENERAL_NATIVE_REF_ERROR ||
      (presence == GENERAL_NATIVE_REF_REGISTERED && !original_initialization_event(&state.event, _operationId, _plan.identity.initialization_digest, next))) goto done;
  query = initialization_query(&_plan.identity, &_installation, context);
  target = read_initialization(query, bytes, &op);
  if (target != GENERAL_NATIVE_ANCHOR_MISSING && target != GENERAL_NATIVE_ANCHOR_FOUND) goto done;
  if (prefix == GENERAL_NATIVE_REPLAY_TAIL) {
    if (!general_native_replay_tail(replay, &tail, tailDigest) || !original_initialization_event(&tail, _operationId, _plan.identity.initialization_digest, next)) goto done;
    if (tail.stage == GENERAL_NATIVE_ADMITTED) {
      if (presence != GENERAL_NATIVE_REF_UNREGISTERED || actual.sequence || target != GENERAL_NATIVE_ANCHOR_MISSING || ![self startedCurrent]) goto done;
    } else if (target != GENERAL_NATIVE_ANCHOR_FOUND || (tail.stage != GENERAL_NATIVE_WRITE_STARTED && tail.stage != GENERAL_NATIVE_UNCERTAIN && tail.stage != GENERAL_NATIVE_COMMITTED)) goto done;
    general_native_replay_destroy(&replay);
    if (!io_current(&op) || general_native_journal_recover_tail(general_native_journal_connection_database(_journal), &actual, &tail, &_installation, NULL, io_current, &op) != GENERAL_NATIVE_APPEND_ANCHORED || !io_current(&op)) goto done;
    actual.sequence = tail.sequence; memcpy(actual.head_digest, tailDigest, 65); state.event = tail; presence = GENERAL_NATIVE_REF_REGISTERED;
  }
  general_native_replay_destroy(&replay);
  if (presence == GENERAL_NATIVE_REF_UNREGISTERED) {
    if (actual.sequence || target != GENERAL_NATIVE_ANCHOR_MISSING || ![self startedCurrent]) goto done;
    memcpy(event.operation_id, _operationId, sizeof(event.operation_id)); memcpy(event.operation_digest, _plan.identity.initialization_digest, sizeof(event.operation_digest));
    memcpy(event.reference, "general-initialization-v1", sizeof("general-initialization-v1")); memcpy(event.next_digest, next, 65);
    if (!append_initialization(&op, &actual, &event, GENERAL_NATIVE_ADMITTED, &_installation)) goto done;
  } else event = state.event;
  if (event.stage == GENERAL_NATIVE_ADMITTED) {
    if (target != GENERAL_NATIVE_ANCHOR_MISSING || ![self startedCurrent] ||
        !append_initialization(&op, &actual, &event, GENERAL_NATIVE_WRITE_STARTED, &_installation) || !add_prepared(query, bytes, &op)) goto done;
  } else if (target != GENERAL_NATIVE_ANCHOR_FOUND) goto done;
  if (event.stage == GENERAL_NATIVE_WRITE_STARTED || event.stage == GENERAL_NATIVE_UNCERTAIN) {
    if (!append_initialization(&op, &actual, &event, GENERAL_NATIVE_COMMITTED, &_installation)) goto done;
  } else if (event.stage != GENERAL_NATIVE_COMMITTED) goto done;
  if (!io_current(&op) || read_initialization(query, bytes, &op) != GENERAL_NATIVE_ANCHOR_FOUND) goto done;
  _preparedHead = actual; _recordPrepared = YES; *record = _record; *head = actual; result = GeneralInitializationPrepared;
done:
  general_native_replay_destroy(&replay); [context invalidate]; if (query) CFRelease(query); if (bytes) CFRelease(bytes);
  if (result != GeneralInitializationPrepared) atomic_store(&_canceled, true);
  _running = NO; return result;
}
- (GeneralInitializationPublication)assignPreparedInitialization {
  if (!NSThread.isMainThread || _closed || _running || !_recordPrepared || !_journal || _assignAttempted) return GeneralInitializationRejected;
  _assignAttempted = _running = YES; GeneralInitializationPublication result = GeneralInitializationUncertain;
  head_io op; general_native_head actual; general_native_replay *replay = NULL; general_native_ref_state state;
  CFDataRef bytes = NULL; CFMutableDictionaryRef query = NULL; char digest[65];
  LAContext *context = [LAContext new]; context.interactionNotAllowed = YES;
  unsigned char encodedHead[GENERAL_NATIVE_HEAD_MAX], payload[32768]; size_t headSize; int size;
  NSString *identifier = nil;
  general_enrollment_request request = { .command = GENERAL_ENROLLMENT_ASSIGN }; general_enrollment_payload checked;
  if (!context || !begin_io(self, false, &op)) goto done;
  op.journal = _journal; op.registered = true;
  if (!io_current(&op) || general_native_anchor_read(&_plan.identity, &_installation, io_current, &op, &actual) != GENERAL_NATIVE_ANCHOR_FOUND || !same_head(&actual, &_preparedHead) ||
      !record_bytes(&_record, &bytes, digest)) goto done;
  query = initialization_query(&_plan.identity, &_installation, context);
  if (read_initialization(query, bytes, &op) != GENERAL_NATIVE_ANCHOR_FOUND) goto done;
  replay = general_native_journal_inspect(_journal, &actual, NULL, io_current, &op);
  if (!replay || general_native_replay_seal(replay) != GENERAL_NATIVE_REPLAY_MATCHED ||
      general_native_replay_lookup(replay, NULL, "general-initialization-v1", &state) != GENERAL_NATIVE_REF_REGISTERED ||
      state.event.stage != GENERAL_NATIVE_COMMITTED || state.event.has_expected || strcmp(state.event.next_digest, digest) ||
      strcmp(state.event.operation_id, _operationId) || strcmp(state.event.operation_digest, _plan.identity.initialization_digest) || !io_current(&op) ||
      !general_native_head_encode(&actual, encodedHead, sizeof(encodedHead), &headSize)) goto done;
  general_native_replay_destroy(&replay);
  size = snprintf((char *)payload, sizeof(payload), "{\"head\":%.*s,\"initialization\":%.*s}", (int)headSize, encodedHead, (int)CFDataGetLength(bytes), CFDataGetBytePtr(bytes));
  if (size < 1 || size >= (int)sizeof(payload)) goto done;
  identifier = NSUUID.UUID.UUIDString.lowercaseString;
  if (!identifier || identifier.length != 36) goto done;
  memcpy(request.request_id, identifier.UTF8String, 37);
  if (!general_enrollment_payload_parse(&request, payload, (size_t)size, &_plan, &checked)) goto done;
  /* Root mutates its non-atomic public records during this command. Validate
   * phases before/after it, keeping immutable auth/peer/code/lock/deadline gates. */
  op.creating = false; op.registered = false;
  if (!io_current(&op) || general_enrollment_client_request_scoped(_client, &request, payload, (size_t)size, io_current, &op) != GENERAL_ENROLLMENT_CLIENT_READY || !io_current(&op)) goto done;
  general_registration_view view;
  if (![self inspect:&view] || view.registration.phase != GENERAL_REGISTRATION_ASSIGNED || !view.assignment_present || !io_current(&op)) goto done;
  _assignedHere = YES; result = GeneralInitializationAssigned;
done:
  general_native_replay_destroy(&replay); [context invalidate]; if (query) CFRelease(query); if (bytes) CFRelease(bytes);
  if (result != GeneralInitializationAssigned) atomic_store(&_canceled, true);
  _running = NO; return result;
}
- (BOOL)transferPreparedResourcesToDirectory:(general_native_directory **)directory
    journal:(general_native_journal_connection **)journal current:(bool (*)(void *))current context:(void *)context {
  if (!NSThread.isMainThread || _closed || _running || !_assignedHere || _transferAttempted || !_recordPrepared ||
      !_directory || !_directoryLoan || !_journal || !directory || *directory || !journal || *journal || !current) return NO;
  _transferAttempted = _running = YES; BOOL transferred = NO;
  head_io op; general_native_head actual; CFDataRef bytes = NULL; CFMutableDictionaryRef query = NULL;
  LAContext *authentication = [LAContext new]; authentication.interactionNotAllowed = YES; char digest[65];
  if (!authentication || !begin_io(self, false, &op)) goto done;
  op.registered = true; op.journal = _journal;
  general_registration_view view;
  if (![self inspect:&view] || view.registration.phase != GENERAL_REGISTRATION_ASSIGNED || !view.assignment_present ||
      !io_current(&op) || general_native_anchor_read(&_plan.identity, &_installation, io_current, &op, &actual) != GENERAL_NATIVE_ANCHOR_FOUND ||
      !same_head(&actual, &_preparedHead) || !record_bytes(&_record, &bytes, digest)) goto done;
  query = initialization_query(&_plan.identity, &_installation, authentication);
  if (read_initialization(query, bytes, &op) != GENERAL_NATIVE_ANCHOR_FOUND || !io_current(&op) || !current(context) || !io_current(&op)) goto done;
  if (!general_native_directory_return(_directory)) goto done;
  _directoryLoan = NO;
  if (!general_native_directory_transfer_lifetime(_directory, current, context) || !general_native_journal_connection_return(_journal)) goto done;
  *directory = _directory; *journal = _journal; _directory = NULL; _journal = NULL;
  _resourcesTransferred = transferred = YES;
done:
  [authentication invalidate]; if (query) CFRelease(query); if (bytes) CFRelease(bytes);
  if (!transferred) atomic_store(&_canceled, true);
  _running = NO; return transferred;
}
- (void)cancel { atomic_store(&_canceled, true); }
- (BOOL)close {
  if (!NSThread.isMainThread || _running || (_transferAttempted && !_resourcesTransferred)) return NO;
  if (_closed) return YES;
  [self cancel];
  if (_journal && !general_native_journal_connection_return(_journal)) return NO;
  _journal = NULL;
  if (_directoryLoan && !general_native_directory_return(_directory)) return NO;
  _directoryLoan = NO;
  if (!general_native_directory_close(&_directory)) return NO;
  if (_loan && !general_enrollment_client_return(_client)) return NO;
  _loan = NO; _closed = YES; _client = NULL; _space = NULL; _authentication = nil; _baseCurrent = nil;
  memset(&_plan, 0, sizeof(_plan)); memset(&_record, 0, sizeof(_record)); memset(&_installation, 0, sizeof(_installation)); memset(&_hello, 0, sizeof(_hello));
  memset(&_preparedHead, 0, sizeof(_preparedHead)); memset(_operationId, 0, sizeof(_operationId));
  memset(&_existingHead, 0, sizeof(_existingHead));
  return YES;
}
@end
