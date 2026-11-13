#import "authentication.h"
#include <time.h>
#include <math.h>

static double auth_now(void) {
  struct timespec value;
  return clock_gettime(CLOCK_MONOTONIC, &value) == 0 ? (double)value.tv_sec + (double)value.tv_nsec / 1000000000.0 : -1;
}

@implementation GeneralScopedAuthentication {
  NSLock *_lock;
  LAContext *_context;
  NSString *_reason;
  NSTimeInterval _timeout;
  double _deadline;
  BOOL (^_current)(void);
  void (^_completion)(GeneralAuthResult);
  BOOL _started, _evaluating, _settled, _canceled, _timedOut;
}
- (instancetype)initWithContext:(LAContext *)context reason:(NSString *)reason timeout:(NSTimeInterval)timeout
  current:(BOOL (^)(void))current completion:(void (^)(GeneralAuthResult))completion {
  if (!(self = [super init])) return nil;
  if (!context || !reason.length || reason.length > 2048 || !isfinite(timeout) || timeout <= 0 || timeout > 60 || !current || !completion) return nil;
  _lock = [NSLock new]; _context = context; _reason = [reason copy]; _timeout = timeout;
  _current = [current copy]; _completion = [completion copy];
  _context.touchIDAuthenticationAllowableReuseDuration = 0;
  return self;
}
- (void)finish:(GeneralAuthResult)result {
  [_lock lock];
  if (_settled) { [_lock unlock]; return; }
  double now = auth_now();
  if (_deadline > 0 && (now < 0 || now >= _deadline)) _timedOut = YES;
  if (_timedOut) result = GeneralAuthTimedOut;
  else if (_canceled) result = GeneralAuthCanceled;
  _settled = YES; _evaluating = NO;
  void (^completion)(GeneralAuthResult) = _completion;
  _completion = nil; _current = nil;
  LAContext *context = _context; _context = nil;
  [_lock unlock];
  [context invalidate];
  completion(result);
}
- (void)reply:(BOOL)success {
  [_lock lock];
  if (_settled) { [_lock unlock]; return; }
  BOOL canceled = _canceled, timedOut = _timedOut;
  BOOL (^current)(void) = _current;
  [_lock unlock];
  BOOL live = current && current();
  [self finish:timedOut ? GeneralAuthTimedOut : canceled || !live ? GeneralAuthCanceled : success ? GeneralAuthApproved : GeneralAuthRejected];
}
- (BOOL)start {
  [_lock lock];
  if (_started || _settled) { [_lock unlock]; return NO; }
  _started = YES;
  double now = auth_now();
  _deadline = now < 0 ? 0 : now + _timeout;
  BOOL canceled = _canceled;
  BOOL (^current)(void) = _current;
  LAContext *context = _context;
  [_lock unlock];
  if (now < 0) { [self finish:GeneralAuthUnavailable]; return YES; }
  if (canceled || !current()) { [self finish:GeneralAuthCanceled]; return YES; }
  NSError *error = nil;
  if (![context canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:&error]) { [self finish:GeneralAuthUnavailable]; return YES; }
  /* Availability may itself block. Recheck the original lifetime before a
   * policy prompt, including any narrower native operation deadline. */
  if (!current()) { [self cancel]; return YES; }
  [_lock lock];
  double ready_now = auth_now();
  if (ready_now < 0 || ready_now >= _deadline) _timedOut = YES;
  if (_canceled || _settled || _timedOut) { [_lock unlock]; [self finish:GeneralAuthCanceled]; return YES; }
  _evaluating = YES;
  [_lock unlock];
  __weak GeneralScopedAuthentication *weak = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(MAX(0, _deadline - auth_now()) * NSEC_PER_SEC)), dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    GeneralScopedAuthentication *owner = weak;
    if (!owner) return;
    [owner expire];
  });
  [context evaluatePolicy:LAPolicyDeviceOwnerAuthentication localizedReason:_reason reply:^(BOOL success, NSError *evaluationError) {
    (void)evaluationError;
    [self reply:success];
  }];
  return YES;
}
- (void)stop:(BOOL)timeout {
  [_lock lock];
  if (_settled) { [_lock unlock]; return; }
  _canceled = YES; _timedOut = _timedOut || timeout;
  BOOL evaluating = _evaluating;
  LAContext *context = _context;
  [_lock unlock];
  [context invalidate];
  /* A canceled evaluation must actually reply before another policy prompt may start. */
  if (!evaluating) [self finish:timeout ? GeneralAuthTimedOut : GeneralAuthCanceled];
}
- (void)expire { [self stop:YES]; }
- (void)cancel { [self stop:NO]; }
- (BOOL)settled { [_lock lock]; BOOL result = _settled; [_lock unlock]; return result; }
@end
