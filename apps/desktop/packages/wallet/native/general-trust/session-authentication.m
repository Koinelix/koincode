#import "session-authentication.h"
#import "session-auth.h"
#import "auth-scope.h"
#include <math.h>
#include <string.h>
#include <time.h>

/* Only the serialized native owner thread touches this actual-policy slot. */
static GeneralSessionAuthentication *pending_policy;
static double seconds(const struct timespec *value) { return (double)value->tv_sec + (double)value->tv_nsec / 1000000000.0; }

@implementation GeneralSessionAuthentication {
  general_session_request _begin;
  general_session_guard *_guard;
  general_initialization_record _initialization;
  NSDictionary *_metadata;
  GeneralScopedAuthentication *_policy;
  BOOL (^_baseCurrent)(void);
  void (^_completion)(GeneralAuthResult);
  double _origin, _last, _maximum;
  GeneralAuthResult _result;
  BOOL _started, _finished, _revoked, _expired, _closed, _checking;
}
- (instancetype)initWithBegin:(const general_session_request *)request value:(NSData *)value
  reservation:(const general_initialization_plan *)reservation guard:(general_session_guard *)guard
  current:(BOOL (^)(void))current completion:(void (^)(GeneralAuthResult))completion {
  if (!(self = [super init])) return nil;
  if (!NSThread.isMainThread || !request || !guard || !current || !completion || ![value isKindOfClass:NSData.class] ||
      !general_session_guard_begin_current(guard, request)) return nil;
  struct timespec origin;
  if (!general_session_guard_begin_started(guard, request, &origin)) return nil;
  NSDictionary *metadata;
  if (request->body.begin.kind == GENERAL_SESSION_BOOTSTRAP_RESTORE) {
    if (value.length || reservation || !request->body.begin.data.bootstrap.byte_length || request->body.begin.data.bootstrap.byte_length > 16777216 ||
        !general_canonical_hash_valid(request->body.begin.data.bootstrap.ciphertext_digest) ||
        (request->body.begin.data.bootstrap.locale != GENERAL_SESSION_EN_US && request->body.begin.data.bootstrap.locale != GENERAL_SESSION_ZH_CN)) return nil;
    metadata = @{@"action":@"bootstrap_restore", @"accountAddress":NSNull.null,
      @"locale":request->body.begin.data.bootstrap.locale == GENERAL_SESSION_EN_US ? @"en-US" : @"zh-CN"};
    _maximum = 180;
  } else {
    general_initialization_record record;
    metadata = general_parse_session_begin_auth(request, value, reservation, &record);
    if (!metadata) return nil;
    if (request->body.begin.kind == GENERAL_SESSION_INITIALIZATION) _initialization = record;
    if ([metadata[@"action"] isEqual:@"manual_transfer"]) _maximum = 20;
  }
  /* Only the admitted begin fields are retained; never an unrelated union tail. */
  _begin.command = GENERAL_SESSION_BEGIN; _begin.sequence = request->sequence; _begin.body.begin = request->body.begin;
  memcpy(_begin.session_id, request->session_id, 37); memcpy(_begin.operation_id, request->operation_id, 37); memcpy(_begin.request_id, request->request_id, 37);
  _guard = guard; _metadata = [metadata copy]; _baseCurrent = [current copy]; _completion = [completion copy];
  _origin = _last = seconds(&origin); _result = GeneralAuthUnavailable;
  return self;
}
- (BOOL)timeCurrent {
  struct timespec stamp;
  if (clock_gettime(CLOCK_MONOTONIC, &stamp) || stamp.tv_sec < 0 || stamp.tv_nsec < 0 || stamp.tv_nsec >= 1000000000) { _revoked = YES; return NO; }
  double now = seconds(&stamp);
  if (!isfinite(now) || now < _last || now < _origin) { _revoked = YES; return NO; }
  _last = now;
  if (_maximum > 0 && now - _origin >= _maximum) { _expired = _revoked = YES; return NO; }
  return YES;
}
- (BOOL)live {
  if (_closed || _revoked || _checking || !_guard || !_baseCurrent) return NO;
  _checking = YES;
  BOOL valid = [self timeCurrent] && _baseCurrent() && [self timeCurrent] &&
    (general_session_guard_begin_current(_guard, &_begin) || (_finished && _result == GeneralAuthApproved && general_session_guard_operation_current(_guard, &_begin)));
  _checking = NO;
  if (!valid) _revoked = YES;
  return valid;
}
- (BOOL)current {
  if (!NSThread.isMainThread) return NO;
  BOOL valid = [self live];
  if (!valid && _policy && !_policy.settled) [_policy cancel];
  return valid;
}
- (BOOL)policyCurrent {
  if (NSThread.isMainThread) return !_finished && [self live];
  __block BOOL valid = NO;
  dispatch_sync(dispatch_get_main_queue(), ^{ valid = !self->_finished && [self live]; });
  return valid;
}
- (void)finish:(GeneralAuthResult)result {
  if (!NSThread.isMainThread || _finished) return;
  BOOL live = [self live];
  if (_expired) result = GeneralAuthTimedOut;
  else if (!live || _revoked) result = GeneralAuthCanceled;
  if (result != GeneralAuthApproved) _revoked = YES;
  _result = result; _finished = YES;
  if (pending_policy == self) pending_policy = nil;
  void (^completion)(GeneralAuthResult) = _completion; _completion = nil;
  if (completion) completion(result);
}
- (void)deadline {
  if (_closed) return;
  if (![self live] && _policy && !_policy.settled) [_policy cancel];
}
- (BOOL)start {
  if (!NSThread.isMainThread || _started || _closed || pending_policy) return NO;
  _started = YES;
  if (![self live]) { [self finish:_expired ? GeneralAuthTimedOut : GeneralAuthCanceled]; return YES; }
  NSString *reason = general_auth_reason(_metadata);
  if (![self live]) { [self finish:_expired ? GeneralAuthTimedOut : GeneralAuthCanceled]; return YES; }
  if (!reason) { [self finish:GeneralAuthUnavailable]; return YES; }
  __weak GeneralSessionAuthentication *weak = self;
  _policy = [[GeneralScopedAuthentication alloc] initWithContext:[LAContext new] reason:reason timeout:60
    current:^BOOL { GeneralSessionAuthentication *owner = weak; return owner && [owner policyCurrent]; }
    completion:^(GeneralAuthResult result) {
      GeneralSessionAuthentication *owner = weak;
      if (!owner) return;
      if (NSThread.isMainThread) [owner finish:result];
      else dispatch_async(dispatch_get_main_queue(), ^{ [owner finish:result]; });
    }];
  if (!_policy) { [self finish:GeneralAuthUnavailable]; return YES; }
  pending_policy = self;
  if (_maximum > 0) {
    double delay = MAX(0, _maximum - (_last - _origin));
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{ [weak deadline]; });
  }
  if (![_policy start]) { [self cancel]; if (_policy.settled && !_finished) [self finish:GeneralAuthUnavailable]; }
  return YES;
}
- (void)cancel {
  if (!NSThread.isMainThread) {
    __weak GeneralSessionAuthentication *weak = self;
    dispatch_async(dispatch_get_main_queue(), ^{ [weak cancel]; }); return;
  }
  _revoked = YES;
  if (_policy && !_policy.settled) [_policy cancel];
}
- (BOOL)authorized {
  return NSThread.isMainThread && _started && _finished && _result == GeneralAuthApproved && [self current] && general_session_guard_operation_current(_guard, &_begin);
}
- (BOOL)authenticatedBegin {
  return NSThread.isMainThread && _started && _finished && _result == GeneralAuthApproved && [self current] && general_session_guard_begin_current(_guard, &_begin);
}
- (BOOL)authorizesCommand:(const general_session_request *)request {
  return NSThread.isMainThread && request && [self authorized] && request->command != GENERAL_SESSION_BEGIN && request->command != GENERAL_SESSION_END &&
    request->command != GENERAL_SESSION_CANCEL && request->command != GENERAL_SESSION_CLOSE &&
    general_session_uuid_valid(request->session_id) && !strcmp(request->session_id, _begin.session_id) &&
    general_session_uuid_valid(request->operation_id) && !strcmp(request->operation_id, _begin.operation_id) &&
    request->sequence > _begin.sequence && request->sequence <= GENERAL_SESSION_SAFE_INTEGER_MAX &&
    general_session_guard_command_current(_guard, request);
}
- (BOOL)drained { return NSThread.isMainThread && (!_policy || (_finished && _policy.settled)); }
- (NSDictionary *)metadata { return NSThread.isMainThread && !_closed ? _metadata : nil; }
- (BOOL)initializationRecord:(general_initialization_record *)out {
  if (!NSThread.isMainThread || _closed || !out || _begin.body.begin.kind != GENERAL_SESSION_INITIALIZATION) return NO;
  *out = _initialization; return YES;
}
- (BOOL)matchesInitializationPlan:(const general_initialization_plan *)plan {
  return NSThread.isMainThread && !_closed && _begin.body.begin.kind == GENERAL_SESSION_INITIALIZATION &&
    general_initialization_binding_valid(&_initialization, plan);
}
- (BOOL)initializationOperationId:(char *)out capacity:(size_t)capacity {
  if (!NSThread.isMainThread || _closed || !out || capacity < 37 || _begin.body.begin.kind != GENERAL_SESSION_INITIALIZATION) return NO;
  memcpy(out, _begin.operation_id, 37); return YES;
}
- (BOOL)close {
  if (!NSThread.isMainThread) return NO;
  if (_closed) return YES;
  [self cancel];
  if (![self drained]) return NO;
  _closed = YES; _guard = NULL; _baseCurrent = nil; _completion = nil; _metadata = nil; _policy = nil;
  general_session_request_clear(&_begin);
  volatile unsigned char *bytes = (volatile unsigned char *)&_initialization;
  for (size_t i = 0; i < sizeof(_initialization); i++) bytes[i] = 0;
  return YES;
}
@end
