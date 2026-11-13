#import "broker-session.h"
#import "session-dispatch.h"
#import "broker-window.h"
#import "head-initialization.h"
#import "profile-origin.h"
#import "management-records.h"
#import "management-record-policy.h"
#include <sys/socket.h>
#include <string.h>

@interface GeneralBrokerSession ()
- (BOOL)physicalCurrent;
- (BOOL)businessCurrent;
@end
static bool physical_current(void *context) { return [(__bridge GeneralBrokerSession *)context physicalCurrent]; }
static bool business_current(void *context) { return [(__bridge GeneralBrokerSession *)context businessCurrent]; }
@implementation GeneralBrokerSession {
  general_broker_namespace *_space; GeneralProfileAuthorization *_profile;
  general_host_launch *_launch; general_host_mode _mode; general_channel_peer *_peer;
  int _fd; BOOL _launchLoan, _peerLoan, _started, _revoked, _closed, _closing, _performing, _uncertain;
  general_broker_window *_window; general_session_dispatch *_dispatch; general_session_guard *_guard;
  GeneralSessionAuthentication *_authentication; GeneralAuthResult _authResult; BOOL _authDone, _controlPending;
  general_session_request _controlRequest;
  GeneralHeadInitialization *_head; general_enrollment_client *_rootClient; BOOL _namespaceLoan;
  general_session_request _pendingRequest; BOOL _businessBorrowed; NSData *_pendingValue;
  general_session_begin_kind _scope; char _operation[37];
  general_initialization_plan _plan;
  general_native_directory *_directory; general_native_journal_connection *_journal;
  general_profile_view *_view; general_profile_origin *_origin; general_resource_session *_resources;
  GeneralManagementRecords *_records;
  NSDictionary *_candidate; general_native_head _candidateHead; unsigned _stateReads; BOOL _inspectionEnded;
  uint64_t _publicRevision;
}
- (instancetype)initWithNamespace:(general_broker_namespace *)space profile:(GeneralProfileAuthorization *)profile
    launch:(general_host_launch *)launch mode:(general_host_mode)mode {
  if (!(self = [super init])) return nil;
  _fd = -1;
  if (!NSThread.isMainThread || !space || ![profile isKindOfClass:GeneralProfileAuthorization.class] || ![profile current] ||
      !launch || !general_host_launch_current(launch) || (mode != GENERAL_HOST_MANAGER && mode != GENERAL_HOST_INSPECT)) return nil;
  _space = space; _profile = profile; _launch = launch; _mode = mode;
  _peer = general_host_launch_borrow(launch); _launchLoan = _peer != NULL;
  if (!_peer) return self;
  _fd = general_channel_peer_borrow(_peer); _peerLoan = _fd >= 0;
  if (_fd < 0) return self;
  _dispatch = general_session_dispatch_create(_fd, physical_current, (__bridge void *)self);
  if (!_dispatch) return self;
  return self;
}
- (BOOL)physicalCurrent {
  return !_closed && !_uncertain && _space && [_profile current] && general_broker_namespace_current(_space) &&
    general_host_launch_current(_launch) && _peer && general_channel_peer_role_current(_peer, GENERAL_CHANNEL_BROKER_HOST);
}
- (BOOL)businessCurrent {
  if (_revoked || ![self physicalCurrent] || (_mode == GENERAL_HOST_MANAGER && (!_window || !general_broker_window_current(_window)))) return NO;
  // During synchronous target IO, unread later wire can only revoke this
  // original slot. It must not allow another write before cancel is parsed.
  if (_performing) {
    unsigned char byte; ssize_t count = recv(_fd, &byte, 1, MSG_PEEK | MSG_DONTWAIT); byte = 0;
    if (count >= 0 || (errno != EAGAIN && errno != EWOULDBLOCK)) { _revoked = YES; return NO; }
  }
  return YES;
}
- (BOOL)start {
  if (_started || !_dispatch || _fd < 0 || ![self physicalCurrent]) return NO;
  _started = general_session_dispatch_start(_dispatch); return _started;
}
- (BOOL)windowReady { return _window && !_revoked && [self physicalCurrent] && general_broker_window_current(_window); }
- (BOOL)pending { return _businessBorrowed || _controlPending || (_authentication && !_authentication.drained); }
- (BOOL)nativeWorkDrained { return !_performing && (!_authentication || _authentication.drained); }
- (int)descriptor { return _started && !_closed ? _fd : -1; }
- (NSDictionary *)publicSnapshotCandidate { return _inspectionEnded && _candidate && ![self pending] ? _candidate : nil; }
- (uint64_t)publicStateRevision { return _publicRevision; }
- (void)capture:(general_native_record_bytes *)bytes snapshot:(const general_profile_snapshot *)snapshot identity:(const general_native_identity *)identity {
  if (_scope != GENERAL_SESSION_INSPECTION || !bytes->bytes || snapshot->initialization.phase != GENERAL_INITIALIZATION_READY || !snapshot->has_binding ||
      !_resources || !general_resource_session_profile_current(_resources, _journal, identity->initialization_id)) { _candidate = nil; _stateReads = 0; return; }
  NSDictionary *state = general_management_checkpoint([NSData dataWithBytes:bytes->bytes length:bytes->size], identity);
  if (!state) { _candidate = nil; _stateReads = 0; return; }
  _stateReads = _stateReads && _candidateHead.sequence == snapshot->head.sequence && !strcmp(_candidateHead.head_digest, snapshot->head.head_digest) ? 2 : 1;
  _candidateHead = snapshot->head; _candidate = nil;
  if (_stateReads < 2) return;
  NSMutableArray *accounts = [NSMutableArray array];
  for (NSDictionary *source in state[@"sources"]) if ([source[@"status"] isEqual:@"ready"])
    [accounts addObject:@{@"sourceId":source[@"id"], @"address":source[@"address"], @"sourceType":source[@"sourceType"], @"backupVerified":source[@"backupVerified"]}];
  NSISO8601DateFormatter *formatter = [NSISO8601DateFormatter new]; formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime | NSISO8601DateFormatWithFractionalSeconds;
  formatter.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0];
  _candidate = @{@"state":@"ready", @"sourceRevision":state[@"revision"], @"observedAt":[formatter stringFromDate:NSDate.date], @"accounts":[accounts copy]};
}
- (BOOL)openProfile {
  if (_view) return _resources && _origin && _records && general_profile_view_current(_view);
  if (!_directory || !_journal) {
    general_registration_view registration;
    if (!general_broker_namespace_inspect(_space, &registration) || !registration.registration_present || !registration.assignment_present ||
        registration.registration.phase != GENERAL_REGISTRATION_ASSIGNED) return NO;
    const general_native_identity *identity = &registration.registration.identity;
    if (general_native_directory_open(identity, false, physical_current, (__bridge void *)self, &_directory) != GENERAL_NATIVE_DIRECTORY_READY) return NO;
    int fd = -1;
    if (!general_native_directory_borrow(_directory, &fd)) return NO;
    _journal = general_native_journal_connection_create(fd);
    BOOL valid = _journal && general_native_journal_connection_open(_journal, physical_current, (__bridge void *)self);
    if (!general_native_directory_return(_directory)) { _uncertain = YES; return NO; }
    if (!valid) return NO;
  }
  _view = general_profile_view_open(_space, _directory, _journal, physical_current, (__bridge void *)self);
  if (!_view || general_profile_origin_open(_view, _directory, physical_current, (__bridge void *)self, &_origin) != GENERAL_PROFILE_ORIGIN_READY) return NO;
  general_native_identity identity; general_session_installation installation; general_native_scope_resolver history; general_resource_origin_resolver origin;
  if (!general_profile_view_identity(_view, &identity, &installation) || !general_profile_view_history(_view, &history) || !general_profile_origin_resolver(_origin, &origin)) return NO;
  _resources = general_resource_session_create(_journal, &identity, &installation, &history, &origin, _peer, physical_current, (__bridge void *)self);
  if (!_resources) return NO;
  _records = [[GeneralManagementRecords alloc] initWithView:_view journal:_journal resources:_resources current:^BOOL { return [self businessCurrent]; }];
  return _records != nil;
}
- (BOOL)initialPlan:(NSData *)value {
  if (!value.length || value.length > 65536) return NO;
  // Preserve the actual canonical record bytes. Foundation's binary key sort
  // differs from the established locale-aware order for initialSigningDomainId.
  // The full original authRequest/record envelope is validated again by the
  // native authentication parser before it can grant any scope.
  NSData *separator = [@",\"record\":" dataUsingEncoding:NSUTF8StringEncoding];
  NSRange found = [value rangeOfData:separator options:NSDataSearchBackwards range:NSMakeRange(0, value.length)];
  if (found.location == NSNotFound || NSMaxRange(found) >= value.length - 1 || ((const unsigned char *)value.bytes)[value.length - 1] != '}') return NO;
  NSData *record = [value subdataWithRange:NSMakeRange(NSMaxRange(found), value.length - NSMaxRange(found) - 1)];
  general_initialization_record body; general_console_identity console; general_session_installation receipt;
  if (!record || !general_initialization_record_parse(record.bytes, record.length, &body) || body.kind != GENERAL_INITIALIZATION_NEW ||
      body.phase != GENERAL_INITIALIZATION_PREPARED || !general_broker_namespace_info(_space, &console, &receipt) ||
      body.identity.uid != console.uid || strcmp(body.identity.installation_id, receipt.installation_id)) return NO;
  _plan = (general_initialization_plan){ .identity = body.identity, .kind = GENERAL_INITIALIZATION_NEW };
  strcpy(_plan.target_state_commitment, body.target_state_commitment); strcpy(_plan.initial_signing_domain_id, body.initial_signing_domain_id);
  return general_initialization_binding_valid(&body, &_plan);
}
- (BOOL)initializeProfile {
  int directory = -1; general_session_locks *locks = NULL; general_enrollment_client *client = NULL;
  if (_directory || _journal || !general_broker_namespace_borrow(_space, &directory, &locks)) return NO;
  _namespaceLoan = YES;
  general_console_identity console; general_session_installation receipt;
  BOOL known = general_broker_namespace_info(_space, &console, &receipt) &&
    general_enrollment_client_open(directory, locks, &receipt, business_current, (__bridge void *)self, &client) == GENERAL_ENROLLMENT_CLIENT_READY;
  _rootClient = client;
  GeneralHeadInitialization *head = known ? [[GeneralHeadInitialization alloc] initWithNamespace:_space client:client
    authentication:_authentication plan:&_plan current:^BOOL { return [self businessCurrent]; }] : nil;
  _head = head;
  general_native_head anchor; general_initialization_record record; general_native_journal_connection *journal = NULL;
  GeneralHeadPreparation prepared = head ? [head prepareHead:&anchor] : GeneralHeadRejected;
  known = (prepared == GeneralHeadCreated || prepared == GeneralHeadExisting) &&
    [head openNativeJournalInFixedNamespace:&journal] == GENERAL_NATIVE_INITIALIZATION_READY;
  if (known) known = (prepared == GeneralHeadCreated ? [head prepareInitializationRecord:&record head:&anchor] :
    [head resumePreparedInitializationRecord:&record head:&anchor]) == GeneralInitializationPrepared;
  if (known) known = [head assignPreparedInitialization] == GeneralInitializationAssigned &&
    [head transferPreparedResourcesToDirectory:&_directory journal:&_journal current:physical_current context:(__bridge void *)self];
  BOOL closed = (!head || [head close]);
  if (closed) { _head = nil; closed = general_enrollment_client_close(&_rootClient); }
  if (closed) { closed = general_broker_namespace_return(_space); if (closed) _namespaceLoan = NO; }
  if (!closed || !known) { _uncertain = YES; return NO; }
  return [self openProfile];
}
- (BOOL)complete:(general_session_reply)reply bytes:(general_native_record_bytes *)bytes {
  BOOL returned = general_session_dispatch_return(_dispatch, false); _businessBorrowed = !returned;
  BOOL result = returned && general_session_dispatch_complete(_dispatch, false, &reply, bytes ? bytes->bytes : NULL, bytes ? bytes->size : 0);
  if (bytes) general_native_record_bytes_destroy(bytes);
  if (!result) return NO;
  return general_session_dispatch_flush(_dispatch, false);
}
- (BOOL)finishBegin {
  if (!_businessBorrowed || !_authDone || !_authentication.drained) return YES;
  general_session_reply reply = { .status = GENERAL_REPLY_REJECTED, .code = GENERAL_REPLY_UNAVAILABLE };
  if (_authResult == GeneralAuthApproved && [self businessCurrent]) {
    _performing = YES;
    BOOL valid = _scope == GENERAL_SESSION_INITIALIZATION ? [self initializeProfile] : [self openProfile];
    _performing = NO;
    if (valid && [self businessCurrent]) reply = (general_session_reply){ .status = GENERAL_REPLY_OK, .code = GENERAL_REPLY_CODE_OK };
    else if (_uncertain) reply = (general_session_reply){ .status = GENERAL_REPLY_UNCERTAIN, .code = GENERAL_REPLY_REGISTRATION_UNCERTAIN };
  } else if (_authResult == GeneralAuthRejected) reply.code = GENERAL_REPLY_AUTH_REJECTED;
  else if (_authResult == GeneralAuthTimedOut) reply.code = GENERAL_REPLY_AUTH_TIMEOUT;
  else if (_authResult == GeneralAuthCanceled || _revoked) reply = (general_session_reply){ .status = GENERAL_REPLY_CANCELED, .code = GENERAL_REPLY_CODE_CANCELED };
  _pendingValue = nil;
  BOOL ok = [self complete:reply bytes:NULL];
  if (ok && reply.status != GENERAL_REPLY_OK) {
    if (![_authentication close] || !general_session_dispatch_guard_return(_dispatch)) return NO;
    _authentication = nil; _guard = NULL; _scope = GENERAL_SESSION_SCOPE_NONE; memset(_operation, 0, sizeof(_operation));
  }
  return ok;
}
- (BOOL)begin:(const general_session_request *)request value:(NSData *)value {
  if (_guard || _scope != GENERAL_SESSION_SCOPE_NONE || _authentication || _revoked ||
      (_mode == GENERAL_HOST_INSPECT && request->body.begin.kind != GENERAL_SESSION_INSPECTION) ||
      (_mode == GENERAL_HOST_MANAGER && ![self windowReady])) return NO;
  _guard = general_session_dispatch_guard_borrow(_dispatch);
  if (!_guard) return NO;
  _candidate = nil; _stateReads = 0; _inspectionEnded = NO;
  if (_publicRevision == GENERAL_SESSION_SAFE_INTEGER_MAX) return NO;
  ++_publicRevision;
  _scope = request->body.begin.kind; strcpy(_operation, request->operation_id);
  if (_scope == GENERAL_SESSION_INSPECTION) {
    general_registration_view registration;
    BOOL valid = general_broker_namespace_inspect(_space, &registration) &&
      (!registration.registration_present && !registration.assignment_present ? YES : [self openProfile]);
    return [self complete:(general_session_reply){ .status = valid ? GENERAL_REPLY_OK : GENERAL_REPLY_REJECTED,
      .code = valid ? GENERAL_REPLY_CODE_OK : GENERAL_REPLY_UNAVAILABLE } bytes:NULL];
  }
  if (_scope != GENERAL_SESSION_OPERATION && _scope != GENERAL_SESSION_INITIALIZATION) return NO;
  if (_scope == GENERAL_SESSION_INITIALIZATION && ![self initialPlan:value]) return NO;
  _authDone = NO; _pendingValue = value;
  _authentication = [[GeneralSessionAuthentication alloc] initWithBegin:request value:value
    reservation:_scope == GENERAL_SESSION_INITIALIZATION ? &_plan : NULL guard:_guard current:^BOOL { return [self businessCurrent]; }
    completion:^(GeneralAuthResult result) { self->_authResult = result; self->_authDone = YES; }];
  return _authentication && [_authentication start] && [self finishBegin];
}
- (general_native_record_status)metadata:(const general_session_request *)request output:(general_native_record_bytes *)bytes {
  if (!general_session_guard_command_current(_guard, request) || ![self businessCurrent]) return GENERAL_NATIVE_RECORD_UNAVAILABLE;
  if (!_view) {
    general_registration_view registration;
    return !strcmp(request->body.reference.reference, "general-initialization-v1") && general_broker_namespace_inspect(_space, &registration) &&
      !registration.registration_present && !registration.assignment_present ? GENERAL_NATIVE_RECORD_UNREGISTERED : GENERAL_NATIVE_RECORD_UNAVAILABLE;
  }
  general_profile_snapshot snapshot; general_native_replay *replay = NULL; general_native_identity identity; general_session_installation receipt;
  general_native_record_status result = GENERAL_NATIVE_RECORD_UNAVAILABLE;
  if (general_profile_view_identity(_view, &identity, &receipt) && general_profile_view_snapshot(_view, &snapshot, &replay)) {
    result = general_native_record_read(&identity, &receipt, replay,
      general_native_reference_profile_scoped(request->body.reference.reference) ? identity.initialization_id : NULL,
      request->body.reference.reference, business_current, (__bridge void *)self, bytes);
    if (result == GENERAL_NATIVE_RECORD_FOUND && !strcmp(request->body.reference.reference, "general-state-v1")) [self capture:bytes snapshot:&snapshot identity:&identity];
  }
  general_native_replay_destroy(&replay); return result;
}
- (BOOL)business:(const general_session_request *)request value:(const unsigned char *)value size:(size_t)size {
  _pendingRequest = *request; _businessBorrowed = YES;
  general_session_reply reply = { .status = GENERAL_REPLY_REJECTED, .code = GENERAL_REPLY_UNAVAILABLE };
  if (request->command == GENERAL_SESSION_WINDOW) {
    BOOL valid = _mode == GENERAL_HOST_MANAGER && !_window && general_broker_window_open(_launch, request->body.window.window_id, &_window);
    if (valid) reply = (general_session_reply){ .status = GENERAL_REPLY_OK, .code = GENERAL_REPLY_CODE_OK };
    return [self complete:reply bytes:NULL];
  }
  if (request->command == GENERAL_SESSION_BEGIN) {
    if ([self begin:request value:[NSData dataWithBytes:value length:size]]) return YES;
    if (!_businessBorrowed) return NO;
    return [self complete:reply bytes:NULL];
  }
  if (request->command == GENERAL_SESSION_END) {
    BOOL inspected = _scope == GENERAL_SESSION_INSPECTION && _stateReads >= 2 && _candidate;
    if (_authentication && ![_authentication close]) return NO;
    _authentication = nil; _pendingValue = nil;
    if (_guard && !general_session_dispatch_guard_return(_dispatch)) return NO;
    _guard = NULL;
    BOOL ok = [self complete:(general_session_reply){ .status = GENERAL_REPLY_OK, .code = GENERAL_REPLY_CODE_OK } bytes:NULL];
    if (ok) { _inspectionEnded = inspected; _scope = GENERAL_SESSION_SCOPE_NONE; memset(_operation, 0, sizeof(_operation)); if (!_closing) _revoked = NO; }
    return ok;
  }
  if (![self businessCurrent] || !_guard || !general_session_guard_command_current(_guard, request)) return [self complete:reply bytes:NULL];
  _performing = YES; general_native_record_bytes bytes = {0};
  if (request->command == GENERAL_SESSION_READ) {
    general_native_record_status found = _scope == GENERAL_SESSION_INSPECTION || !strcmp(request->body.reference.reference, "general-initialization-v1") ||
      !strcmp(request->body.reference.reference, "general-domain-binding-v1") ? [self metadata:request output:&bytes] :
      [_records read:request authentication:_authentication output:&bytes];
    if (found == GENERAL_NATIVE_RECORD_FOUND || found == GENERAL_NATIVE_RECORD_UNREGISTERED) reply = (general_session_reply){ .status = GENERAL_REPLY_OK, .code = GENERAL_REPLY_CODE_OK,
      .kind = found == GENERAL_NATIVE_RECORD_FOUND ? GENERAL_REPLY_READ_PRESENT : GENERAL_REPLY_READ_MISSING };
  } else if (request->command == GENERAL_SESSION_WRITE && _scope != GENERAL_SESSION_INSPECTION && [_authentication authorizesCommand:request]) {
    _candidate = nil; _stateReads = 0; _inspectionEnded = NO;
    general_management_write_result written = [_records write:request value:[NSData dataWithBytes:value length:size] authentication:_authentication];
    if (written == GENERAL_MANAGEMENT_WRITE_COMMITTED || written == GENERAL_MANAGEMENT_WRITE_IDENTICAL) reply = (general_session_reply){ .status = GENERAL_REPLY_OK, .code = GENERAL_REPLY_CODE_OK };
    else if (written == GENERAL_MANAGEMENT_WRITE_UNCERTAIN) reply = (general_session_reply){ .status = GENERAL_REPLY_UNCERTAIN, .code = GENERAL_REPLY_REGISTRATION_UNCERTAIN };
  } else if (request->command == GENERAL_SESSION_RESOURCE && _resources &&
      (_scope == GENERAL_SESSION_INSPECTION ? request->body.resource.action != GENERAL_RESOURCE_START : [_authentication authorizesCommand:request])) {
    int database = -1, lease = -1; BOOL rights = request->body.resource.action == GENERAL_RESOURCE_COMMIT;
    BOOL borrowed = !rights || general_session_dispatch_resource_descriptors_borrow(_dispatch, &database, &lease);
    if (borrowed && !(_scope == GENERAL_SESSION_INSPECTION ? general_resource_session_execute_readonly(_resources, request, database, lease, &reply) :
        general_resource_session_execute(_resources, request, database, lease, &reply))) reply = (general_session_reply){ .status = GENERAL_REPLY_UNCERTAIN, .code = GENERAL_REPLY_REGISTRATION_UNCERTAIN };
    if (rights && borrowed && !general_session_dispatch_resource_descriptors_return(_dispatch)) _uncertain = YES;
  }
  _performing = NO;
  if (![self businessCurrent]) { general_native_record_bytes_destroy(&bytes); reply = (general_session_reply){ .status = GENERAL_REPLY_CANCELED, .code = GENERAL_REPLY_CODE_CANCELED }; }
  return [self complete:reply bytes:&bytes];
}
- (BOOL)finishControl {
  if (!_controlPending || _businessBorrowed || (_authentication && !_authentication.drained)) return YES;
  if (_controlRequest.command == GENERAL_SESSION_CLOSE) {
    if (_authentication && ![_authentication close]) return NO;
    _authentication = nil;
    if (_guard && !general_session_dispatch_guard_return(_dispatch)) return NO;
    _guard = NULL;
    if (_operation[0] && !general_session_dispatch_scope_drained(_dispatch, _operation)) return NO;
    _scope = GENERAL_SESSION_SCOPE_NONE; memset(_operation, 0, sizeof(_operation));
  }
  general_session_reply reply = { .status = GENERAL_REPLY_OK, .code = GENERAL_REPLY_CODE_OK };
  if (!general_session_dispatch_complete(_dispatch, true, &reply, NULL, 0)) return NO;
  _controlPending = NO;
  return general_session_dispatch_flush(_dispatch, true);
}
- (BOOL)step {
  if (!_started || _closed || _uncertain) return NO;
  if (_businessBorrowed && _authDone && ![self finishBegin]) return NO;
  if (![self finishControl]) return NO;
  general_session_dispatch_result result = general_session_dispatch_poll(_dispatch);
  if (result == GENERAL_DISPATCH_WAIT || result == GENERAL_DISPATCH_REJECTED) return YES;
  if (result == GENERAL_DISPATCH_BROKEN) { [self cancel]; return NO; }
  const general_session_request *request = NULL; const unsigned char *value = NULL; size_t size = 0;
  BOOL control = result == GENERAL_DISPATCH_CONTROL;
  if (!general_session_dispatch_borrow(_dispatch, control, &request, &value, &size)) return NO;
  if (!control) return [self business:request value:value size:size];
  _controlRequest = *request; _controlPending = YES;
  [_authentication cancel];
  if (request->command == GENERAL_SESSION_CLOSE) _closing = _revoked = YES;
  return general_session_dispatch_return(_dispatch, true) && [self finishControl];
}
- (void)cancel { _closing = _revoked = YES; [_authentication cancel]; }
- (BOOL)close {
  [self cancel];
  if (_closed) return YES;
  if (_authentication && ![_authentication close]) return NO;
  _authentication = nil;
  general_session_dispatch_stop(_dispatch);
  if (_businessBorrowed) {
    general_session_dispatch_stop(_dispatch);
    if (![self complete:(general_session_reply){ .status = GENERAL_REPLY_CANCELED, .code = GENERAL_REPLY_CODE_CANCELED } bytes:NULL] && _businessBorrowed) return NO;
  }
  if (_guard && !general_session_dispatch_guard_return(_dispatch)) return NO;
  _guard = NULL;
  if (_operation[0] && !general_session_dispatch_scope_drained(_dispatch, _operation)) return NO;
  memset(_operation, 0, sizeof(_operation)); _scope = GENERAL_SESSION_SCOPE_NONE;
  if (_controlPending) {
    general_session_reply reply = { .status = GENERAL_REPLY_OK, .code = GENERAL_REPLY_CODE_OK };
    if (!general_session_dispatch_complete(_dispatch, true, &reply, NULL, 0)) return NO;
    _controlPending = NO;
  }
  if (_head && ![_head close]) return NO;
  _head = nil;
  if (!general_enrollment_client_close(&_rootClient)) return NO;
  if (_namespaceLoan && !general_broker_namespace_return(_space)) return NO;
  _namespaceLoan = NO;
  if (![_records close]) { if (_records) return NO; }
  _records = nil;
  if (_resources && (!general_resource_session_drain_reaped(_resources, _launch) || !general_resource_session_close(&_resources))) return NO;
  if (!general_profile_origin_close(&_origin) || !general_profile_view_close(&_view) ||
      general_native_journal_connection_close(&_journal) != GENERAL_NATIVE_CONNECTION_CLOSED || !general_native_directory_close(&_directory) ||
      !general_session_dispatch_close(&_dispatch) || !general_broker_window_close(&_window)) return NO;
  if (_peerLoan && !general_channel_peer_return(_peer)) return NO;
  _peerLoan = NO;
  if (_launchLoan && !general_host_launch_return(_launch)) return NO;
  _launchLoan = NO; _closed = YES; return YES;
}
@end
