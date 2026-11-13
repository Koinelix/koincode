#import "broker-control.h"
#import "broker-session.h"
#import "control-protocol.h"
#include "control-io.h"
#include "session-canonical.h"
#include <poll.h>
#include <string.h>
#include <time.h>

static double monotonic(void) {
  struct timespec value;
  return clock_gettime(CLOCK_MONOTONIC, &value) ? -1 : (double)value.tv_sec + (double)value.tv_nsec / 1000000000.0;
}
static void uuid(char output[37]) { memcpy(output, NSUUID.UUID.UUIDString.lowercaseString.UTF8String, 37); }
@interface GeneralPublicController : NSObject
- (int)run;
- (BOOL)current;
@end
static bool base_current(void *context) { return [(__bridge GeneralPublicController *)context current]; }
@implementation GeneralPublicController {
  general_control_io *_io; char _control[37], _window[37], _view[37];
  NSMutableSet *_ids; uint64_t _sequence, _delivery, _generation;
  general_control_request _business, _closing; BOOL _hasBusiness, _hasClosing, _connected, _fatal, _stop;
  BOOL _draining, _natural, _managerOpened, _eventsSent, _released;
  double _deadline, _last;
  general_control_status _result; NSDictionary *_point;
  general_broker_namespace *_space; GeneralProfileAuthorization *_profile;
  general_host_launch *_launch; GeneralBrokerSession *_session;
  general_host_mode _mode;
  uint64_t _nativeRevision;
}
- (BOOL)current {
  double time = monotonic();
  if (time < 0 || time < _last) return NO;
  _last = time;
  return !_fatal && !_stop && (!_draining || (_released && _natural)) && _connected &&
    general_control_io_current(_io) && (!_deadline || time < _deadline);
}
- (BOOL)send:(NSData *)frame {
  if (!_connected || !frame || !general_control_io_write(_io, frame.bytes, frame.length)) { _connected = NO; return NO; }
  return YES;
}
- (BOOL)reply:(const general_control_request *)request status:(general_control_status)status body:(NSDictionary *)body {
  if (_delivery == GENERAL_SESSION_SAFE_INTEGER_MAX) return NO;
  return [self send:general_control_reply(request, ++_delivery, status, body)];
}
- (NSDictionary *)snapshot:(NSDictionary *)point {
  if (_generation == GENERAL_SESSION_SAFE_INTEGER_MAX) return nil;
  uuid(_view); ++_generation;
  NSMutableDictionary *body = [point mutableCopy];
  body[@"format"] = @"koincode-general-wallet-view"; body[@"version"] = @1;
  body[@"viewId"] = [NSString stringWithUTF8String:_view]; body[@"generation"] = @(_generation);
  return [body copy];
}
- (NSDictionary *)emptyPoint:(NSString *)state {
  return @{@"state":state, @"sourceRevision":NSNull.null, @"observedAt":NSNull.null, @"accounts":@[]};
}
- (void)drain:(general_control_status)status natural:(BOOL)natural {
  if (_draining) return;
  _result = status; _natural = natural; _draining = YES;
  // Revocation precedes cleanup. A naturally completed inspector has already
  // ended its scope and must be allowed to close its repositories and exit 0.
  if (!natural) { [_session cancel]; general_host_launch_cancel(_launch); _point = nil; }
}
- (BOOL)events {
  if (!_managerOpened || _eventsSent || !_connected) return YES;
  if (_generation == GENERAL_SESSION_SAFE_INTEGER_MAX || _delivery > GENERAL_SESSION_SAFE_INTEGER_MAX - 2) return NO;
  ++_generation;
  BOOL ok = [self send:general_control_event(_control, ++_delivery, _view, _generation, NO)] &&
    [self send:general_control_event(_control, ++_delivery, _view, _generation, YES)];
  _eventsSent = YES; return ok;
}
- (BOOL)cleanup {
  if (_launch && !general_host_launch_reaped(_launch)) return YES;
  if (_session && ![_session nativeWorkDrained]) return YES;
  BOOL completed = !_natural || !_launch || general_host_launch_exit_success(_launch);
  // Each owner is closed once. Unknown native cleanup terminates this dedicated
  // process without publishing accounts or reusing any retained capability.
  if (_session && ![_session close]) return NO;
  _session = nil;
  if (!general_host_launch_close(&_launch)) return NO;
  if (_profile && ![_profile close]) return NO;
  _profile = nil;
  BOOL publish = _hasBusiness && _business.command == GENERAL_CONTROL_SNAPSHOT && _result == GENERAL_CONTROL_OK && completed && _point && _connected;
  if (_space && !_released) {
    // This terminal release lends no user namespace. Installation SH remains
    // retained until the reply is physically written on the original pipe.
    if (!general_broker_namespace_release_user(_space)) return NO;
    _released = YES;
  }
  if (publish && (!general_broker_namespace_installation_current(_space) || _last >= _deadline)) publish = NO;
  if (![self events]) return NO;
  if (_hasBusiness && _connected) {
    general_control_status status = _result;
    if (_business.command == GENERAL_CONTROL_SNAPSHOT && status == GENERAL_CONTROL_OK && !publish) status = GENERAL_CONTROL_UNAVAILABLE;
    if (![self reply:&_business status:status body:publish ? [self snapshot:_point] : @{}]) return NO;
  }
  if (_hasClosing && _connected && ![self reply:&_closing status:GENERAL_CONTROL_OK body:@{}]) return NO;
  BOOL close = _hasClosing && _closing.command == GENERAL_CONTROL_CLOSE;
  if (!general_broker_namespace_close(&_space)) return NO;
  _hasBusiness = _hasClosing = _draining = _natural = _managerOpened = _eventsSent = _released = NO;
  _deadline = 0; _point = nil; _mode = 0; _nativeRevision = 0;
  if (close || !_connected) _stop = YES;
  return YES;
}
- (void)start:(const general_control_request *)request {
  _business = *request; _hasBusiness = YES; _deadline = monotonic() + 30;
  _mode = request->command == GENERAL_CONTROL_SNAPSHOT ? GENERAL_HOST_INSPECT : GENERAL_HOST_MANAGER;
  general_broker_namespace_result opened = _mode == GENERAL_HOST_INSPECT ?
    general_broker_namespace_open_inspection(base_current, (__bridge void *)self, &_space) :
    general_broker_namespace_open(base_current, (__bridge void *)self, &_space);
  if (opened != GENERAL_BROKER_NAMESPACE_READY) { [self drain:opened == GENERAL_BROKER_NAMESPACE_BUSY ? GENERAL_CONTROL_BUSY : GENERAL_CONTROL_UNAVAILABLE natural:NO]; return; }
  _profile = [[GeneralProfileAuthorization alloc] initWithNamespace:_space];
  if (!_profile || ![_profile current] || ![self current]) { [self drain:GENERAL_CONTROL_UNAVAILABLE natural:NO]; return; }
  if (_mode == GENERAL_HOST_INSPECT) {
    general_registration_view registration;
    if (!general_broker_namespace_inspect(_space, &registration)) { [self drain:GENERAL_CONTROL_UNAVAILABLE natural:NO]; return; }
    if (!registration.registration_present || !registration.assignment_present) {
      _point = [self emptyPoint:!registration.registration_present && !registration.assignment_present ? @"needs_initialization" : @"recovery_required"];
      [self drain:GENERAL_CONTROL_OK natural:YES]; return;
    }
  }
  general_host_launch_result launched = general_host_launch_open(_space, _mode, base_current, (__bridge void *)self, &_launch);
  if (launched != GENERAL_HOST_LAUNCH_READY || ![self current]) { [self drain:launched == GENERAL_HOST_LAUNCH_BUSY ? GENERAL_CONTROL_BUSY : GENERAL_CONTROL_UNAVAILABLE natural:NO]; return; }
  _session = [[GeneralBrokerSession alloc] initWithNamespace:_space profile:_profile launch:_launch mode:_mode];
  if (!_session || ![_session start]) [self drain:GENERAL_CONTROL_UNAVAILABLE natural:NO];
}
- (BOOL)accept:(const general_control_request *)request {
  NSString *id = [NSString stringWithUTF8String:request->request_id];
  if (strcmp(request->control_id, _control) || request->sequence != _sequence + 1 ||
      (_window[0] && strcmp(request->window_id, _window)) || _ids.count >= GENERAL_CONTROL_ID_LIMIT || [_ids containsObject:id]) return NO;
  ++_sequence; [_ids addObject:id]; if (!_window[0]) strcpy(_window, request->window_id);
  if (request->command == GENERAL_CONTROL_CLOSE || request->command == GENERAL_CONTROL_CANCEL) {
    if (_hasClosing) return [self reply:request status:GENERAL_CONTROL_BUSY body:@{}];
    BOOL matching = _hasBusiness && !strcmp(request->target_id, _business.request_id);
    if (request->command == GENERAL_CONTROL_CANCEL && !matching) return [self reply:request status:GENERAL_CONTROL_UNAVAILABLE body:@{}];
    _closing = *request; _hasClosing = YES;
    if (_draining) { _natural = NO; _point = nil; _result = GENERAL_CONTROL_CANCELED; [_session cancel]; general_host_launch_cancel(_launch); }
    else [self drain:GENERAL_CONTROL_CANCELED natural:NO];
    return YES;
  }
  if (_hasBusiness || _draining) return [self reply:request status:GENERAL_CONTROL_BUSY body:@{}];
  if (_session) {
    if ([_session pending] || ![_session windowReady]) return [self reply:request status:GENERAL_CONTROL_BUSY body:@{}];
    if (request->command == GENERAL_CONTROL_OPEN_MANAGER) return [self reply:request status:GENERAL_CONTROL_OK body:@{@"opened":@YES}];
    NSDictionary *candidate = [_session publicSnapshotCandidate];
    return [self reply:request status:candidate ? GENERAL_CONTROL_OK : GENERAL_CONTROL_BUSY body:candidate ? [self snapshot:candidate] : @{}];
  }
  [self start:request]; return YES;
}
- (void)advance {
  if (_draining) { if (![self cleanup]) _fatal = YES; return; }
  if (!_session) return;
  if (![self current]) { [self drain:GENERAL_CONTROL_UNAVAILABLE natural:NO]; return; }
  struct pollfd readable = { .fd = [_session descriptor], .events = POLLIN | POLLHUP };
  int result = poll(&readable, 1, 0);
  if (result < 0 || (readable.revents & (POLLERR | POLLNVAL))) { [self drain:GENERAL_CONTROL_UNAVAILABLE natural:NO]; return; }
  if ((readable.revents & (POLLIN | POLLHUP)) || [_session pending]) {
    if (![_session step]) { [self drain:GENERAL_CONTROL_UNAVAILABLE natural:NO]; return; }
  }
  if (_mode == GENERAL_HOST_INSPECT) {
    NSDictionary *candidate = [_session publicSnapshotCandidate];
    if (candidate) { _point = candidate; [self drain:GENERAL_CONTROL_OK natural:YES]; }
  } else if (_hasBusiness && [_session windowReady]) {
    if (![self reply:&_business status:GENERAL_CONTROL_OK body:@{@"opened":@YES}]) { [self drain:GENERAL_CONTROL_UNAVAILABLE natural:NO]; return; }
    _hasBusiness = NO; _managerOpened = YES; _deadline = 0;
  }
  if (_mode == GENERAL_HOST_MANAGER && [_session publicStateRevision] != _nativeRevision) {
    _nativeRevision = [_session publicStateRevision];
    if (_generation && _managerOpened) {
      if (_generation == GENERAL_SESSION_SAFE_INTEGER_MAX || _delivery == GENERAL_SESSION_SAFE_INTEGER_MAX ||
          ![self send:general_control_event(_control, ++_delivery, _view, ++_generation, NO)]) [self drain:GENERAL_CONTROL_UNAVAILABLE natural:NO];
    }
  }
}
- (int)run {
  _io = general_control_io_open(); if (!_io) return 74;
  _connected = YES; _sequence = _delivery = _generation = 0; _last = monotonic();
  uuid(_control); uuid(_view); _ids = [NSMutableSet set];
  if (![self send:general_control_hello(_control)]) _stop = YES;
  while (!_stop && !_fatal) @autoreleasepool {
    unsigned char bytes[GENERAL_CONTROL_REQUEST_MAX]; size_t size = 0;
    general_control_io_result read = _connected ? general_control_io_read(_io, bytes, &size) : GENERAL_CONTROL_IO_EOF;
    if (read == GENERAL_CONTROL_IO_FRAME) {
      general_control_request request;
      if (!general_control_request_parse([NSData dataWithBytes:bytes length:size], &request) || ![self accept:&request]) _connected = NO;
    } else if (read != GENERAL_CONTROL_IO_WAIT) _connected = NO;
    if (!_connected && !_draining) [self drain:GENERAL_CONTROL_CANCELED natural:NO];
    [self advance];
    if (_stop || _fatal) break;
    if (_draining) {
      [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
      continue;
    }
    unsigned bound = [_session pending] ? 20 : 0;
    if (_deadline) {
      double remaining = (_deadline - monotonic()) * 1000;
      if (remaining <= 0) { [self drain:GENERAL_CONTROL_UNAVAILABLE natural:NO]; continue; }
      if (!bound || remaining < bound) bound = (unsigned)remaining + 1;
    }
    if (!general_control_io_wait(_io, _session ? [_session descriptor] : -1, bound)) _connected = NO;
    [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:NSDate.date];
  }
  // On uncertainty, original native objects remain retained until this actual
  // dedicated process exits. Never publish a successful close or retry them.
  if (_fatal || _space || _launch || _session || !general_control_io_close(&_io)) return 74;
  return _connected ? 0 : 74;
}
@end
int general_broker_control_run(void) { return [[GeneralPublicController new] run]; }
