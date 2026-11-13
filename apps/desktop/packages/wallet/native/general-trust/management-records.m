#import "management-records.h"
#import "management-record-policy.h"
#include "native-store-private.h"
#include "native-journal-append.h"
#include <time.h>
#include <uuid/uuid.h>

static bool records_current(void *context);
@interface GeneralManagementRecords ()
- (BOOL)operationCurrent;
@end
@implementation GeneralManagementRecords {
  general_profile_view *_view;
  general_native_journal_connection *_journal;
  general_resource_session *_resources;
  BOOL (^_baseCurrent)(void);
  GeneralSessionAuthentication *_authentication;
  general_session_request _request;
  general_native_identity _identity;
  general_session_installation _installation;
  general_native_scope_resolver _history;
  struct timespec _origin, _last;
  BOOL _running, _uncertain, _journalLoan, _closed, _initializing;
}
- (instancetype)initWithView:(general_profile_view *)view journal:(general_native_journal_connection *)journal current:(BOOL (^)(void))current {
  return [self initWithView:view journal:journal resources:NULL current:current];
}
- (instancetype)initWithView:(general_profile_view *)view journal:(general_native_journal_connection *)journal
  resources:(general_resource_session *)resources current:(BOOL (^)(void))current {
  if (!(self = [super init])) return nil;
  if (!NSThread.isMainThread || !view || !journal || !current || !current() || !general_profile_view_current(view) ||
      !general_profile_view_uses_journal(view, journal) || !general_profile_view_identity(view, &_identity, &_installation) ||
      !general_profile_view_history(view, &_history) || !general_store_installation_valid(&_identity, &_installation)) return nil;
  _view = view; _journal = journal; _resources = resources; _baseCurrent = [current copy]; return self;
}
- (BOOL)operationCurrent {
  struct timespec now;
  if (!NSThread.isMainThread || !_running || _closed || !_baseCurrent || !_baseCurrent() ||
      ![_authentication authorizesCommand:&_request] || !general_profile_view_current(_view) ||
      !general_native_journal_connection_current(_journal) ||
      (_initializing && !general_resource_session_profile_current(_resources, _journal, _identity.initialization_id)) ||
      clock_gettime(CLOCK_MONOTONIC, &now) ||
      now.tv_sec < _last.tv_sec || now.tv_nsec < 0 || now.tv_nsec >= 1000000000 ||
      (now.tv_sec == _last.tv_sec && now.tv_nsec < _last.tv_nsec)) return NO;
  _last = now;
  return now.tv_sec - _origin.tv_sec < 30 || (now.tv_sec - _origin.tv_sec == 30 && now.tv_nsec < _origin.tv_nsec);
}
- (BOOL)begin:(const general_session_request *)request authentication:(GeneralSessionAuthentication *)authentication
  snapshot:(general_profile_snapshot *)snapshot replay:(general_native_replay **)replay {
  if (!NSThread.isMainThread || _running || _closed || _uncertain || !request || !authentication || !snapshot || !replay || *replay ||
      ![authentication authorizesCommand:request] || (request->command != GENERAL_SESSION_READ && request->command != GENERAL_SESSION_WRITE)) return NO;
  /* Freeze before executing any external lifetime callback. */
  _request = *request; _authentication = authentication; _running = YES;
  if (clock_gettime(CLOCK_MONOTONIC, &_origin) || _origin.tv_sec < 0 || _origin.tv_nsec < 0 || _origin.tv_nsec >= 1000000000) return NO;
  _last = _origin;
  if (![self operationCurrent] || !general_profile_view_snapshot(_view, snapshot, replay)) return NO;
  general_initialization_plan plan = { .identity = _identity, .kind = GENERAL_INITIALIZATION_NEW };
  strcpy(plan.target_state_commitment, snapshot->initialization.target_state_commitment);
  strcpy(plan.initial_signing_domain_id, snapshot->initialization.initial_signing_domain_id);
  _initializing = [authentication matchesInitializationPlan:&plan];
  if ((!_initializing && (snapshot->initialization.phase != GENERAL_INITIALIZATION_READY || !snapshot->has_binding)) ||
      ![self operationCurrent] || !general_native_journal_connection_borrow(_journal)) return NO;
  _journalLoan = YES;
  general_native_head actual;
  return [self operationCurrent] && general_native_anchor_read(&_identity, &_installation, records_current, (__bridge void *)self, &actual) == GENERAL_NATIVE_ANCHOR_FOUND &&
    actual.sequence == snapshot->head.sequence && !strcmp(actual.head_digest, snapshot->head.head_digest) &&
    general_native_head_same_identity(&actual, &_identity) && [self operationCurrent];
}
- (BOOL)finish {
  BOOL ok = YES;
  if (_journalLoan && !_uncertain) {
    if (general_native_journal_connection_return(_journal)) _journalLoan = NO;
    else { _uncertain = YES; ok = NO; }
  }
  general_session_request_clear(&_request); _authentication = nil; _running = NO; _initializing = NO; return ok;
}
- (general_native_record_status)readReference:(const char *)reference replay:(general_native_replay *)replay
  output:(general_native_record_bytes *)out {
  general_native_ref_state state;
  general_native_ref_presence presence = general_native_replay_lookup(replay, general_native_reference_profile_scoped(reference) ? _identity.initialization_id : NULL, reference, &state);
  if (presence == GENERAL_NATIVE_REF_ERROR) return GENERAL_NATIVE_RECORD_INVALID;
  if (presence == GENERAL_NATIVE_REF_UNREGISTERED) return GENERAL_NATIVE_RECORD_UNREGISTERED;
  if (state.event.stage != GENERAL_NATIVE_COMMITTED) return GENERAL_NATIVE_RECORD_UNSETTLED;
  LAContext *context = [LAContext new]; context.interactionNotAllowed = YES;
  CFMutableDictionaryRef query = context ? general_store_query(&_identity, &_installation, general_native_reference_profile_scoped(reference) ? _identity.initialization_id : NULL, reference, context) : NULL;
  CFTypeRef result = NULL; general_native_record_bytes owned = {0};
  OSStatus status = query && [self operationCurrent] ? SecItemCopyMatching(query, &result) : errSecNotAvailable;
  general_native_record_status outcome = GENERAL_NATIVE_RECORD_UNAVAILABLE;
  if ([self operationCurrent]) {
    if (status == errSecItemNotFound) outcome = GENERAL_NATIVE_RECORD_CONFLICT;
    else if (status == errSecSuccess) {
      CFDataRef actual = general_store_body(result, query, state.event.next_digest); outcome = GENERAL_NATIVE_RECORD_CONFLICT;
      if (actual && [self operationCurrent]) {
        owned.size = (size_t)CFDataGetLength(actual); owned.bytes = malloc(owned.size);
        if (owned.bytes) { memcpy(owned.bytes, CFDataGetBytePtr(actual), owned.size); outcome = GENERAL_NATIVE_RECORD_FOUND; }
        else { owned.size = 0; outcome = GENERAL_NATIVE_RECORD_UNAVAILABLE; }
      }
    }
  }
  if (result) CFRelease(result); if (query) CFRelease(query); [context invalidate];
  if (![self operationCurrent]) outcome = GENERAL_NATIVE_RECORD_UNAVAILABLE;
  if (outcome == GENERAL_NATIVE_RECORD_FOUND) *out = owned; else general_native_record_bytes_destroy(&owned);
  return outcome;
}
- (BOOL)missing:(const char *)reference {
  LAContext *context = [LAContext new]; context.interactionNotAllowed = YES;
  CFMutableDictionaryRef query = context ? general_store_query(&_identity, &_installation, general_native_reference_profile_scoped(reference) ? _identity.initialization_id : NULL, reference, context) : NULL;
  CFTypeRef result = NULL;
  OSStatus status = query && [self operationCurrent] ? SecItemCopyMatching(query, &result) : errSecNotAvailable;
  BOOL missing = status == errSecItemNotFound && !result && [self operationCurrent];
  if (result) CFRelease(result); if (query) CFRelease(query); [context invalidate]; return missing;
}
- (NSDictionary *)checkpoint:(general_native_replay *)replay {
  general_native_record_bytes bytes = {0}; NSDictionary *state = nil;
  if ([self readReference:"general-state-v1" replay:replay output:&bytes] == GENERAL_NATIVE_RECORD_FOUND)
    state = general_management_checkpoint([NSData dataWithBytes:bytes.bytes length:bytes.size], &_identity);
  general_native_record_bytes_destroy(&bytes); return state;
}
- (general_native_record_status)read:(const general_session_request *)request
  authentication:(GeneralSessionAuthentication *)authentication output:(general_native_record_bytes *)out {
  if (!NSThread.isMainThread || _running || _closed || _uncertain || !out || out->bytes || out->size || !request || request->command != GENERAL_SESSION_READ) return GENERAL_NATIVE_RECORD_INVALID;
  general_native_record_status result = GENERAL_NATIVE_RECORD_UNAVAILABLE;
  general_profile_snapshot snapshot; general_native_replay *replay = NULL; general_native_record_bytes owned = {0};
  if ([self begin:request authentication:authentication snapshot:&snapshot replay:&replay]) {
    const char *reference = _request.body.reference.reference;
    BOOL key = !strncmp(reference, "source-key:", 11);
    if (!strcmp(reference, "general-state-v1") || !strcmp(reference, "general-signing-registry-v1")) {
      result = [self readReference:reference replay:replay output:&owned];
      if (result == GENERAL_NATIVE_RECORD_UNREGISTERED) {
        BOOL initialMissing = _initializing && ((!strcmp(reference, "general-state-v1") && snapshot.initialization.phase == GENERAL_INITIALIZATION_PREPARED) ||
          (!strcmp(reference, "general-signing-registry-v1") && snapshot.initialization.phase <= GENERAL_INITIALIZATION_STATE_PUBLISHED));
        if (!initialMissing || ![self missing:reference]) result = GENERAL_NATIVE_RECORD_CONFLICT;
      }
    } else if (key && !_initializing) {
      NSDictionary *state = [self checkpoint:replay];
      NSString *name = [NSString stringWithUTF8String:reference];
      if (state && general_management_key_scope([_authentication metadata], state, name, NO)) {
        result = [self readReference:reference replay:replay output:&owned];
        if (result == GENERAL_NATIVE_RECORD_FOUND && owned.size != 32) result = GENERAL_NATIVE_RECORD_CONFLICT;
        /* Unregistered is an absence observation only after a real DP query.
         * It never authorizes Add, replacement or an orphaned key reset. */
        if (result == GENERAL_NATIVE_RECORD_UNREGISTERED && ![self missing:reference]) result = GENERAL_NATIVE_RECORD_CONFLICT;
      } else result = GENERAL_NATIVE_RECORD_INVALID;
    } else result = GENERAL_NATIVE_RECORD_INVALID;
    if (![self operationCurrent]) result = GENERAL_NATIVE_RECORD_UNAVAILABLE;
  }
  general_native_replay_destroy(&replay);
  if (_running && ![self finish]) result = GENERAL_NATIVE_RECORD_UNAVAILABLE;
  if (result == GENERAL_NATIVE_RECORD_FOUND) *out = owned; else general_native_record_bytes_destroy(&owned);
  return result;
}
- (BOOL)append:(general_native_event *)event head:(general_native_head *)head stage:(general_native_stage)stage {
  event->stage = stage; event->sequence = head->sequence + 1; strcpy(event->previous_digest, head->head_digest);
  general_native_append_status result = general_native_journal_append(general_native_journal_connection_database(_journal), head, event,
    &_installation, &_history, records_current, (__bridge void *)self);
  if (result != GENERAL_NATIVE_APPEND_REJECTED) _uncertain = YES;
  if (result != GENERAL_NATIVE_APPEND_ANCHORED) return NO;
  head->sequence = event->sequence; return general_native_event_digest(event, head->head_digest) && [self operationCurrent];
}
- (BOOL)mutate:(NSData *)value reference:(const char *)reference existing:(BOOL)existing digest:(const char *)digest {
  LAContext *context = [LAContext new]; context.interactionNotAllowed = YES;
  CFMutableDictionaryRef query = context ? general_store_query(&_identity, &_installation, general_native_reference_profile_scoped(reference) ? _identity.initialization_id : NULL, reference, context) : NULL;
  CFMutableDictionaryRef target = query ? CFDictionaryCreateMutableCopy(NULL, 0, query) : NULL;
  CFDictionaryRef change = CFDictionaryCreate(NULL, (const void *[]){kSecValueData}, (const void *[]){(__bridge CFTypeRef)value}, 1,
    &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  BOOL valid = NO;
  if (target && change && [self operationCurrent]) {
    CFDictionaryRemoveValue(target, kSecReturnAttributes); CFDictionaryRemoveValue(target, kSecReturnData); CFDictionaryRemoveValue(target, kSecMatchLimit);
    OSStatus status;
    if (existing) status = SecItemUpdate(target, change);
    else { CFDictionarySetValue(target, kSecValueData, (__bridge CFTypeRef)value); status = SecItemAdd(target, NULL); }
    if (status == errSecSuccess && [self operationCurrent]) {
      CFTypeRef result = NULL; status = SecItemCopyMatching(query, &result);
      CFDataRef actual = status == errSecSuccess && [self operationCurrent] ? general_store_body(result, query, digest) : NULL;
      valid = actual && CFDataGetLength(actual) == (CFIndex)value.length && !memcmp(CFDataGetBytePtr(actual), value.bytes, value.length);
      if (result) CFRelease(result);
    }
  }
  if (change) CFRelease(change); if (target) CFRelease(target); if (query) CFRelease(query); [context invalidate];
  return valid && [self operationCurrent];
}
static BOOL value_digest(NSData *value, char out[65]) {
  unsigned char hash[CC_SHA256_DIGEST_LENGTH]; static const char alphabet[] = "0123456789abcdef";
  if (!value || !value.length || value.length > GENERAL_SESSION_VALUE_MAX || !CC_SHA256(value.bytes, (CC_LONG)value.length, hash)) return NO;
  for (unsigned i = 0; i < sizeof(hash); i++) { out[i * 2] = alphabet[hash[i] >> 4]; out[i * 2 + 1] = alphabet[hash[i] & 15]; }
  out[64] = 0; return YES;
}
- (general_management_write_result)writeAccepted:(const char *)reference value:(NSData *)value expected:(const char *)expected head:(general_native_head *)head {
  general_management_write_result result = GENERAL_MANAGEMENT_WRITE_REJECTED;
  general_native_replay *replay = NULL; general_native_record_bytes previous = {0}; char hex[65];
  if (!general_canonical_reference_valid(reference) || !value_digest(value, hex) || ![self operationCurrent]) goto done;
  replay = general_native_journal_inspect(_journal, head, &_history, records_current, (__bridge void *)self);
  if (!replay || !general_native_replay_matched_head(replay, head)) goto done;
  general_native_ref_state accepted;
  general_native_ref_presence presence = general_native_replay_lookup(replay,
    general_native_reference_profile_scoped(reference) ? _identity.initialization_id : NULL, reference, &accepted);
  if (presence == GENERAL_NATIVE_REF_ERROR || (presence == GENERAL_NATIVE_REF_REGISTERED && accepted.event.stage != GENERAL_NATIVE_COMMITTED)) goto done;
  BOOL existing = presence == GENERAL_NATIVE_REF_REGISTERED;
  if (existing) {
    if ([self readReference:reference replay:replay output:&previous] != GENERAL_NATIVE_RECORD_FOUND) goto done;
    if (!strcmp(accepted.event.next_digest, hex) && previous.size == value.length && !memcmp(previous.bytes, value.bytes, previous.size)) {
      result = GENERAL_MANAGEMENT_WRITE_IDENTICAL; goto done;
    }
    if (!expected || strcmp(expected, accepted.event.next_digest)) goto done;
  } else if (expected || ![self missing:reference]) goto done;
  if (head->sequence > GENERAL_NATIVE_EVENT_LIMIT - 3 || ![self operationCurrent]) goto done;
  general_native_event event = { .has_expected = existing };
  uuid_t generated; uuid_generate_random(generated); uuid_unparse_lower(generated, event.operation_id);
  strcpy(event.reference, reference); strcpy(event.operation_digest, hex); strcpy(event.next_digest, hex);
  if (existing) strcpy(event.expected_digest, accepted.event.next_digest);
  if (![self append:&event head:head stage:GENERAL_NATIVE_ADMITTED] || ![self append:&event head:head stage:GENERAL_NATIVE_WRITE_STARTED] ||
      ![self mutate:value reference:reference existing:existing digest:hex] || ![self append:&event head:head stage:GENERAL_NATIVE_COMMITTED]) goto done;
  _uncertain = NO; result = GENERAL_MANAGEMENT_WRITE_COMMITTED;
done:
  general_native_record_bytes_destroy(&previous); general_native_replay_destroy(&replay); return _uncertain ? GENERAL_MANAGEMENT_WRITE_UNCERTAIN : result;
}
- (BOOL)advanceInitialization:(general_initialization_record *)record phase:(general_initialization_phase)phase head:(general_native_head *)head {
  general_native_replay *replay = general_native_journal_inspect(_journal, head, &_history, records_current, (__bridge void *)self);
  general_native_record_bytes bytes = {0}; general_initialization_record actual;
  unsigned char before[GENERAL_NATIVE_INITIALIZATION_MAX], next[GENERAL_NATIVE_INITIALIZATION_MAX]; size_t beforeSize, nextSize; char expected[65];
  BOOL valid = replay && [self readReference:"general-initialization-v1" replay:replay output:&bytes] == GENERAL_NATIVE_RECORD_FOUND &&
    general_initialization_record_parse(bytes.bytes, bytes.size, &actual) && general_initialization_record_encode(record, before, sizeof(before), &beforeSize) &&
    beforeSize == bytes.size && !memcmp(before, bytes.bytes, beforeSize);
  NSData *original = valid ? [NSData dataWithBytes:bytes.bytes length:bytes.size] : nil;
  general_initialization_plan plan = { .identity = _identity, .kind = GENERAL_INITIALIZATION_NEW };
  strcpy(plan.target_state_commitment, record->target_state_commitment); strcpy(plan.initial_signing_domain_id, record->initial_signing_domain_id);
  general_initialization_record proposed = *record; proposed.phase = phase;
  valid = valid && general_initialization_advance_valid(record, &proposed, &plan) && [_authentication matchesInitializationPlan:&plan] &&
    value_digest(original, expected) && general_initialization_record_encode(&proposed, next, sizeof(next), &nextSize);
  general_native_record_bytes_destroy(&bytes); general_native_replay_destroy(&replay);
  if (!valid) return NO;
  general_management_write_result result = [self writeAccepted:"general-initialization-v1" value:[NSData dataWithBytes:next length:nextSize] expected:expected head:head];
  if (result != GENERAL_MANAGEMENT_WRITE_COMMITTED && result != GENERAL_MANAGEMENT_WRITE_IDENTICAL) return NO;
  *record = proposed; return [self operationCurrent];
}
- (BOOL)completeInitialization:(const char *)reference snapshot:(general_profile_snapshot *)snapshot {
  general_initialization_record *record = &snapshot->initialization;
  if (!strcmp(reference, "general-state-v1")) return record->phase == GENERAL_INITIALIZATION_STATE_PUBLISHED ||
    (record->phase == GENERAL_INITIALIZATION_PREPARED && [self advanceInitialization:record phase:GENERAL_INITIALIZATION_STATE_PUBLISHED head:&snapshot->head]);
  if (strcmp(reference, "general-signing-registry-v1")) return NO;
  if (record->phase == GENERAL_INITIALIZATION_STATE_PUBLISHED &&
      ![self advanceInitialization:record phase:GENERAL_INITIALIZATION_JOURNAL_PUBLISHED head:&snapshot->head]) return NO;
  if (record->phase != GENERAL_INITIALIZATION_JOURNAL_PUBLISHED) return NO;
  general_domain_binding binding; unsigned char bytes[GENERAL_DOMAIN_BINDING_MAX]; size_t size; char history[GENERAL_SESSION_REFERENCE_MAX + 1];
  if (!general_domain_binding_initial(record, &binding) || !general_domain_binding_encode(&binding, bytes, sizeof(bytes), &size) ||
      snprintf(history, sizeof(history), "general-domain-binding:%s", binding.binding_digest) >= (int)sizeof(history)) return NO;
  NSData *value = [NSData dataWithBytes:bytes length:size];
  const char *references[] = { history, "general-domain-binding-v1" };
  for (unsigned i = 0; i < 2; i++) {
    general_management_write_result result = [self writeAccepted:references[i] value:value expected:NULL head:&snapshot->head];
    if (result != GENERAL_MANAGEMENT_WRITE_COMMITTED && result != GENERAL_MANAGEMENT_WRITE_IDENTICAL) return NO;
  }
  return [self advanceInitialization:record phase:GENERAL_INITIALIZATION_READY head:&snapshot->head];
}
- (general_management_write_result)write:(const general_session_request *)request value:(NSData *)input
  authentication:(GeneralSessionAuthentication *)authentication {
  if (!NSThread.isMainThread || _running || _closed || _uncertain || !request || request->command != GENERAL_SESSION_WRITE || ![input isKindOfClass:NSData.class] || !input.length || input.length > 512 * 1024)
    return GENERAL_MANAGEMENT_WRITE_REJECTED;
  /* Own and wipe the copied command value through all real native callbacks. */
  NSMutableData *value = [input mutableCopy];
  general_management_write_result result = GENERAL_MANAGEMENT_WRITE_REJECTED;
  general_profile_snapshot snapshot; general_native_replay *replay = NULL; NSDictionary *state = nil;
  if (![self begin:request authentication:authentication snapshot:&snapshot replay:&replay]) goto done;
  const char *reference = _request.body.write.reference;
  unsigned char hash[CC_SHA256_DIGEST_LENGTH]; char hex[65]; static const char alphabet[] = "0123456789abcdef";
  if (!CC_SHA256(value.bytes, (CC_LONG)value.length, hash)) goto done;
  for (unsigned i = 0; i < sizeof(hash); i++) { hex[i * 2] = alphabet[hash[i] >> 4]; hex[i * 2 + 1] = alphabet[hash[i] & 15]; } hex[64] = 0;
  if (strcmp(hex, _request.body.write.next_digest)) goto done;
  if (_initializing) {
    if (!strcmp(reference, "general-state-v1")) {
      if (snapshot.initialization.phase > GENERAL_INITIALIZATION_STATE_PUBLISHED || !general_management_initial_checkpoint(value, &snapshot.initialization)) goto done;
    } else if (!strcmp(reference, "general-signing-registry-v1")) {
      general_native_record_bytes checkpoint = {0};
      BOOL valid = snapshot.initialization.phase >= GENERAL_INITIALIZATION_STATE_PUBLISHED && snapshot.initialization.phase <= GENERAL_INITIALIZATION_JOURNAL_PUBLISHED &&
        [self readReference:"general-state-v1" replay:replay output:&checkpoint] == GENERAL_NATIVE_RECORD_FOUND;
      NSData *original = valid ? [NSData dataWithBytes:checkpoint.bytes length:checkpoint.size] : nil;
      state = valid ? general_management_checkpoint(original, &_identity) : nil;
      valid = valid && general_management_initial_checkpoint(original, &snapshot.initialization) && general_management_initial_registry(value, state, &snapshot.initialization);
      general_native_record_bytes_destroy(&checkpoint); if (!valid) goto done;
    } else goto done;
  } else {
    state = [self checkpoint:replay]; if (!state) goto done;
    if (!strcmp(reference, "general-state-v1")) {
    NSDictionary *next = general_management_checkpoint(value, &_identity);
    if (!next || !general_management_state_advance([_authentication metadata], state, next)) goto done;
    for (NSDictionary *source in next[@"sources"]) {
      general_native_record_bytes key = {0};
      BOOL found = [self readReference:[source[@"keyRef"] UTF8String] replay:replay output:&key] == GENERAL_NATIVE_RECORD_FOUND && key.size == 32;
      general_native_record_bytes_destroy(&key); if (!found) goto done;
    }
  } else if (!strncmp(reference, "source-key:", 11)) {
    if (value.length != 32 || _request.body.write.has_expected ||
        !general_management_key_scope([_authentication metadata], state, [NSString stringWithUTF8String:reference], YES)) goto done;
    } else goto done;
  }
  result = [self writeAccepted:reference value:value expected:_request.body.write.has_expected ? _request.body.write.expected_digest : NULL head:&snapshot.head];
  if (_initializing && (result == GENERAL_MANAGEMENT_WRITE_COMMITTED || result == GENERAL_MANAGEMENT_WRITE_IDENTICAL) &&
      ![self completeInitialization:reference snapshot:&snapshot]) { _uncertain = YES; result = GENERAL_MANAGEMENT_WRITE_UNCERTAIN; }
done:
  general_native_replay_destroy(&replay);
  if (_running) { if (_uncertain) result = GENERAL_MANAGEMENT_WRITE_UNCERTAIN; if (![self finish]) result = GENERAL_MANAGEMENT_WRITE_UNCERTAIN; }
  [value resetBytesInRange:NSMakeRange(0, value.length)]; return result;
}
- (BOOL)close {
  if (!NSThread.isMainThread || _running || _uncertain || _journalLoan) return NO;
  if (_closed) return YES;
  _closed = YES; _view = NULL; _journal = NULL; _resources = NULL; _baseCurrent = nil; _authentication = nil;
  general_session_request_clear(&_request); memset(&_identity, 0, sizeof(_identity)); memset(&_installation, 0, sizeof(_installation)); return YES;
}
@end
static bool records_current(void *context) { return [(__bridge GeneralManagementRecords *)context operationCurrent]; }
