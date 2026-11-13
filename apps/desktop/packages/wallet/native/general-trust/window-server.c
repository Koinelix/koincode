#include "window-server.h"
#include <ApplicationServices/ApplicationServices.h>
static bool integer(CFTypeRef value, int64_t *out) {
  return value && CFGetTypeID(value) == CFNumberGetTypeID() && !CFNumberIsFloatType(value) && CFNumberGetValue(value, kCFNumberSInt64Type, out);
}
bool general_window_server_matches(uint32_t window_id, pid_t expected_pid) {
  if (!window_id || expected_pid <= 1) return false;
  CFArrayRef windows = CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, window_id);
  bool valid = false; int64_t number, pid, layer;
  if (windows && CFGetTypeID(windows) == CFArrayGetTypeID() && CFArrayGetCount(windows) == 1) {
    CFTypeRef item = CFArrayGetValueAtIndex(windows, 0);
    if (item && CFGetTypeID(item) == CFDictionaryGetTypeID()) {
      CFDictionaryRef row = item;
      valid = integer(CFDictionaryGetValue(row, kCGWindowNumber), &number) && number == window_id &&
        integer(CFDictionaryGetValue(row, kCGWindowOwnerPID), &pid) && pid == expected_pid &&
        integer(CFDictionaryGetValue(row, kCGWindowLayer), &layer) && layer == 0 &&
        CFDictionaryGetValue(row, kCGWindowIsOnscreen) == kCFBooleanTrue;
    }
  }
  if (windows) CFRelease(windows); return valid;
}
