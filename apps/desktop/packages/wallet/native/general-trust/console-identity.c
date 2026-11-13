#include "console-identity.h"
#include <SystemConfiguration/SystemConfiguration.h>
#include <pwd.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define ACCOUNT_BUFFER 65536U
static bool bounded(const char *value, size_t capacity) { return value && strnlen(value, capacity) > 0 && strnlen(value, capacity) < capacity; }
static bool home_valid(const char *value) {
  if (!bounded(value, PATH_MAX) || value[0] != '/' || value[1] == 0) return false;
  const char *part = value + 1;
  for (const char *cursor = part;; cursor++) if (*cursor == '/' || *cursor == 0) {
    size_t size = (size_t)(cursor - part);
    if ((size == 1 && part[0] == '.') || (size == 2 && part[0] == '.' && part[1] == '.')) return false;
    if (!*cursor) return true; part = cursor + 1;
  }
}
static bool identity_valid(const general_console_identity *value) {
  return value && value->uid && value->uid < UINT32_MAX && value->gid < UINT32_MAX && bounded(value->account, sizeof(value->account)) &&
    strcmp(value->account, "loginwindow") && !strchr(value->account, '/') && home_valid(value->home);
}
static bool active(bool (*current)(void *), void *context, const struct timespec *started) {
  struct timespec now;
  if (!current(context) || clock_gettime(CLOCK_MONOTONIC, &now) || now.tv_sec < started->tv_sec ||
      (now.tv_sec == started->tv_sec && now.tv_nsec < started->tv_nsec)) return false;
  time_t seconds = now.tv_sec - started->tv_sec;
  return seconds < 30 || (seconds == 30 && now.tv_nsec < started->tv_nsec);
}
static void erase(void *value, size_t size) { volatile unsigned char *bytes = value; while (size--) *bytes++ = 0; }
bool general_console_identity_read(bool (*current)(void *), void *context, general_console_identity *out) {
  if (!current || !out) return false;
  struct timespec started; if (clock_gettime(CLOCK_MONOTONIC, &started) || !active(current, context, &started)) return false;
  uid_t uid = 0; gid_t gid = 0;
  CFStringRef account = SCDynamicStoreCopyConsoleUser(NULL, &uid, &gid);
  general_console_identity value = { .uid = uid, .gid = gid };
  bool valid = account && CFGetTypeID(account) == CFStringGetTypeID() && CFStringGetCString(account, value.account, sizeof(value.account), kCFStringEncodingUTF8);
  if (account) CFRelease(account);
  if (!valid || !uid || uid == UINT32_MAX || gid == UINT32_MAX || !active(current, context, &started)) return false;
  char *buffer = malloc(ACCOUNT_BUFFER); if (!buffer) return false;
  struct passwd entry, *result = NULL; memset(&entry, 0, sizeof(entry));
  int status = getpwuid_r(uid, &entry, buffer, ACCOUNT_BUFFER, &result);
  valid = !status && result == &entry && entry.pw_uid == uid && entry.pw_gid == gid && bounded(entry.pw_name, sizeof(value.account)) &&
    !strcmp(entry.pw_name, value.account) && bounded(entry.pw_dir, sizeof(value.home));
  if (valid) { memcpy(value.home, entry.pw_dir, strlen(entry.pw_dir) + 1); valid = identity_valid(&value) && active(current, context, &started); }
  erase(buffer, ACCOUNT_BUFFER); free(buffer); erase(&entry, sizeof(entry));
  if (!valid) return false;
  *out = value; return true;
}
bool general_console_identity_matches(const general_console_identity *expected, bool (*current)(void *), void *context) {
  if (!identity_valid(expected)) return false;
  general_console_identity actual;
  return general_console_identity_read(current, context, &actual) && actual.uid == expected->uid && actual.gid == expected->gid &&
    !strcmp(actual.account, expected->account) && !strcmp(actual.home, expected->home);
}
