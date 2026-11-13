#include "trust.h"
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>

#define MAX_LAUNCH_BYTES (1024U * 1024U)

static const unsigned char *string_end(const unsigned char *start, const unsigned char *end) {
  return start < end ? memchr(start, 0, (size_t)(end - start)) : NULL;
}

/* This is defense in depth, not immutable proof of the original environment. */
bool general_launch_arguments_valid(const unsigned char *bytes, size_t size, const char *executable) {
  if (!bytes || !executable || !*executable || size <= sizeof(int) || size > MAX_LAUNCH_BYTES) return false;
  int argc = 0; memcpy(&argc, bytes, sizeof(argc));
  if (argc != 1) return false;
  const unsigned char *end = bytes + size, *value = bytes + sizeof(argc), *stop = string_end(value, end);
  size_t path_size = strlen(executable);
  if (!stop || (size_t)(stop - value) != path_size || memcmp(value, executable, path_size) != 0) return false;
  value = stop + 1;
  while (value < end && *value == 0) value++;
  stop = string_end(value, end);
  if (!stop || (size_t)(stop - value) != path_size || memcmp(value, executable, path_size) != 0) return false;
  value = stop + 1;
  /* Environment may be omitted by macOS. Never interpret its absence as sanitization. */
  while (value < end) {
    if (*value == 0) { value++; continue; }
    stop = string_end(value, end);
    if (!stop) return false;
    const unsigned char *separator = memchr(value, '=', (size_t)(stop - value));
    if (!separator || separator == value) return false;
    for (const unsigned char *key = value; key < separator; key++) {
      if (!((*key >= 'A' && *key <= 'Z') || (*key >= 'a' && *key <= 'z') || *key == '_' ||
          (key > value && *key >= '0' && *key <= '9'))) return false;
    }
    value = stop + 1;
  }
  return true;
}

bool general_peer_launch_valid(int fd, const audit_token_t *token) {
  if (!token) return false;
  int max_mib[] = { CTL_KERN, KERN_ARGMAX }, maximum = 0;
  size_t maximum_size = sizeof(maximum);
  if (sysctl(max_mib, 2, &maximum, &maximum_size, NULL, 0) != 0 || maximum_size != sizeof(maximum) ||
      maximum <= (int)sizeof(int) || maximum > (int)MAX_LAUNCH_BYTES) return false;
  unsigned char *bytes = malloc((size_t)maximum);
  if (!bytes) return false;
  size_t size = (size_t)maximum;
  int mib[] = { CTL_KERN, KERN_PROCARGS2, audit_token_to_pid(*token) };
  bool valid = sysctl(mib, 3, bytes, &size, NULL, 0) == 0 && size <= (size_t)maximum &&
    general_launch_arguments_valid(bytes, size, GENERAL_TRUST_EXECUTABLE);
  volatile unsigned char *clear = bytes;
  for (size_t i = 0; i < (size_t)maximum; i++) clear[i] = 0;
  free(bytes);
  audit_token_t current; SecCodeRef code = NULL;
  if (!valid || !general_socket_peer(fd, &current, &code)) return false;
  bool same_peer = memcmp(&current, token, sizeof(current)) == 0;
  CFRelease(code); return same_peer;
}
