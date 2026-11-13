#include "session-installation.h"
#include "binary-plist.h"
#include <CoreFoundation/CoreFoundation.h>

static bool integer(CFTypeRef value, int64_t *out) {
  return value && CFGetTypeID(value) == CFNumberGetTypeID() && !CFNumberIsFloatType((CFNumberRef)value) &&
    CFNumberGetValue((CFNumberRef)value, kCFNumberSInt64Type, out);
}
static bool text(CFTypeRef value, char *out, size_t length) {
  return value && CFGetTypeID(value) == CFStringGetTypeID() && CFStringGetLength((CFStringRef)value) == (CFIndex)length &&
    CFStringGetCString((CFStringRef)value, out, (CFIndex)length + 1, kCFStringEncodingASCII);
}
static bool hash(CFTypeRef value, unsigned char out[20]) {
  if (!value || CFGetTypeID(value) != CFDataGetTypeID() || CFDataGetLength((CFDataRef)value) != 20) return false;
  memcpy(out, CFDataGetBytePtr((CFDataRef)value), 20);
  unsigned char bits = 0;
  for (size_t i = 0; i < 20; i++) bits |= out[i];
  return bits != 0;
}
bool general_parse_session_installation(const unsigned char *bytes, size_t size, general_session_installation *output) {
  if (!output || size > GENERAL_SESSION_RECEIPT_MAX || !general_plist_dictionary_count(bytes, size, 8)) return false;
  CFDataRef data = CFDataCreate(NULL, bytes, (CFIndex)size);
  if (!data) return false;
  CFPropertyListFormat format = 0;
  CFPropertyListRef value = CFPropertyListCreateWithData(NULL, data, kCFPropertyListImmutable, &format, NULL);
  CFRelease(data);
  if (!value) return false;
  bool ok = false; general_session_installation parsed = {0}; int64_t version = 0;
  if (format != kCFPropertyListBinaryFormat_v1_0 || CFGetTypeID(value) != CFDictionaryGetTypeID()) goto done;
  CFDictionaryRef row = (CFDictionaryRef)value;
  if (CFDictionaryGetCount(row) != 8) goto done;
  CFTypeRef marker = CFDictionaryGetValue(row, CFSTR("format"));
  if (!marker || CFGetTypeID(marker) != CFStringGetTypeID() || !CFEqual(marker, CFSTR("koincode-general-wallet-installation")) ||
      !integer(CFDictionaryGetValue(row, CFSTR("version")), &version) || version != 2 ||
      !integer(CFDictionaryGetValue(row, CFSTR("revision")), &parsed.revision) || parsed.revision < 1 || parsed.revision > 9007199254740991LL ||
      !text(CFDictionaryGetValue(row, CFSTR("installationId")), parsed.installation_id, 36) ||
      !hash(CFDictionaryGetValue(row, CFSTR("hostCdHash")), parsed.host_hash) ||
      !hash(CFDictionaryGetValue(row, CFSTR("brokerCdHash")), parsed.broker_hash) ||
      !text(CFDictionaryGetValue(row, CFSTR("teamId")), parsed.team_id, 10) ||
      !text(CFDictionaryGetValue(row, CFSTR("keychainAccessGroup")), parsed.keychain_access_group, sizeof(parsed.keychain_access_group) - 1)) goto done;
  for (size_t i = 0; i < 36; i++) {
    char c = parsed.installation_id[i];
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (c != '-') goto done; }
    else if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) goto done;
  }
  for (size_t i = 0; i < 10; i++) {
    char c = parsed.team_id[i]; if (!((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'))) goto done;
  }
  if (memcmp(parsed.keychain_access_group, parsed.team_id, 10) != 0 ||
      strcmp(parsed.keychain_access_group + 10, GENERAL_SESSION_ACCESS_GROUP_SUFFIX) != 0) goto done;
  *output = parsed; ok = true;
done:
  CFRelease(value); return ok;
}
