#import "host-window.h"
#include "window-server.h"
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <unistd.h>

@interface GeneralHostWindowObservation : NSObject
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) NSView *view;
@property(nonatomic, strong) NSArray *tokens;
@property(nonatomic, assign) BOOL revoked;
@end
@implementation GeneralHostWindowObservation
@end
struct general_host_window {
  general_host_bootstrap *bootstrap;
  void *observation;
  uint32_t window_id;
  bool running, uncertain;
};
static atomic_flag attempted = ATOMIC_FLAG_INIT;
static NSView *find_view(NSView *view, uintptr_t target, unsigned depth, unsigned *visited) {
  if (!view || depth > 64 || ++*visited > 4096) return nil;
  if ((uintptr_t)(__bridge void *)view == target) return view;
  NSArray<NSView *> *children = view.subviews;
  if (children.count > 4096 - *visited) return nil;
  for (NSView *child in children) { NSView *found = find_view(child, target, depth + 1, visited); if (found) return found; }
  return nil;
}
static bool actual_window(general_host_window *owner, GeneralHostWindowObservation *observation) {
  if (!NSThread.isMainThread || observation.revoked || !NSApp || !observation.window || !observation.view ||
      !general_host_bootstrap_current(owner->bootstrap)) return false;
  NSArray<NSWindow *> *windows = NSApp.windows;
  if (windows.count > 256 || ![windows containsObject:observation.window] || observation.window.windowNumber != owner->window_id ||
      !observation.window.visible || observation.window.miniaturized || observation.view.window != observation.window || !observation.window.contentView) return false;
  unsigned visited = 0;
  return find_view(observation.window.contentView, (uintptr_t)(__bridge void *)observation.view, 0, &visited) == observation.view &&
    general_window_server_matches(owner->window_id, getpid()) && !observation.revoked && general_host_bootstrap_current(owner->bootstrap);
}
bool general_host_window_open(general_host_bootstrap *bootstrap, uintptr_t native_view, uint32_t window_id, general_host_window **out) {
  @autoreleasepool {
    general_host_mode mode; general_session_installation receipt;
    if (!NSThread.isMainThread || !bootstrap || !native_view || !window_id || !out || *out || !NSApp ||
        !general_host_bootstrap_info(bootstrap, &mode, &receipt) || mode != GENERAL_HOST_MANAGER || atomic_flag_test_and_set(&attempted)) return false;
    general_host_window *owner = calloc(1, sizeof(*owner)); if (!owner) return false;
    owner->bootstrap = bootstrap; owner->window_id = window_id;
    GeneralHostWindowObservation *observation = [GeneralHostWindowObservation new];
    if (!observation) { free(owner); return false; }
    owner->observation = (void *)CFBridgingRetain(observation);
    @try {
      NSArray<NSWindow *> *windows = NSApp.windows;
      if (windows.count <= 256) for (NSWindow *window in windows) {
        if (window.windowNumber != window_id || !window.contentView || !window.visible || window.miniaturized) continue;
        unsigned visited = 0; NSView *view = find_view(window.contentView, native_view, 0, &visited);
        if (view) { observation.window = window; observation.view = view; break; }
      }
      if (!actual_window(owner, observation)) { if (!general_host_window_close(&owner)) *out = owner; return false; }
      __weak GeneralHostWindowObservation *weak = observation;
      NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
      NSMutableArray *tokens = [NSMutableArray new];
      for (NSNotificationName name in @[NSWindowWillCloseNotification, NSWindowDidMiniaturizeNotification]) {
        id token = [center addObserverForName:name object:observation.window queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
          (void)note; weak.revoked = YES;
        }];
        if (token) [tokens addObject:token];
      }
      id inactive = [NSWorkspace.sharedWorkspace.notificationCenter addObserverForName:NSWorkspaceSessionDidResignActiveNotification object:nil
        queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) { (void)note; weak.revoked = YES; }];
      if (inactive) [tokens addObject:inactive];
      observation.tokens = tokens;
      if (tokens.count != 3 || !actual_window(owner, observation)) { if (!general_host_window_close(&owner)) *out = owner; return false; }
      *out = owner; return true;
    } @catch (NSException *exception) {
      (void)exception; observation.revoked = YES; owner->uncertain = true; *out = owner; return false;
    }
  }
}
bool general_host_window_current(general_host_window *owner) {
  @autoreleasepool {
    if (!owner || !NSThread.isMainThread || owner->running || owner->uncertain || !owner->observation) return false;
    owner->running = true;
    GeneralHostWindowObservation *observation = (__bridge GeneralHostWindowObservation *)owner->observation;
    bool valid = false;
    @try { valid = actual_window(owner, observation); }
    @catch (NSException *exception) { (void)exception; owner->uncertain = true; }
    if (!valid) observation.revoked = YES;
    owner->running = false; return valid;
  }
}
void general_host_window_invalidate(general_host_window *owner) {
  if (owner && NSThread.isMainThread && owner->observation) ((__bridge GeneralHostWindowObservation *)owner->observation).revoked = YES;
}
bool general_host_window_sensitive_current(general_host_window *owner) {
  @autoreleasepool {
    if (!general_host_window_current(owner)) return false;
    GeneralHostWindowObservation *observation = (__bridge GeneralHostWindowObservation *)owner->observation;
    @try {
      return NSApp.active && NSApp.keyWindow == observation.window && observation.window.keyWindow &&
        actual_window(owner, observation);
    } @catch (NSException *exception) {
      (void)exception; owner->uncertain = true; observation.revoked = YES; return false;
    }
  }
}
bool general_host_window_close(general_host_window **pointer) {
  @autoreleasepool {
    if (!pointer || !*pointer) return true;
    general_host_window *owner = *pointer;
    if (!NSThread.isMainThread || owner->running || owner->uncertain) return false;
    GeneralHostWindowObservation *observation = (__bridge GeneralHostWindowObservation *)owner->observation;
    observation.revoked = YES;
    @try {
      for (id token in observation.tokens) {
        [NSNotificationCenter.defaultCenter removeObserver:token];
        [NSWorkspace.sharedWorkspace.notificationCenter removeObserver:token];
      }
      observation.tokens = nil; observation.window = nil; observation.view = nil;
      CFRelease(owner->observation); free(owner); *pointer = NULL; return true;
    } @catch (NSException *exception) { (void)exception; owner->uncertain = true; return false; }
  }
}
