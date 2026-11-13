#include "assignment.h"
#include "binary-plist.h"
#include <CoreFoundation/CoreFoundation.h>
#include <string.h>

static const char signing_policy_digest[] = "bc4de042d0a1cf3d9ba868395d7759339fe9e6e6fbcc8874673caf92d5c7bc10";

static bool number(CFTypeRef value, int64_t *out) {
  return value && CFGetTypeID(value) == CFNumberGetTypeID() && !CFNumberIsFloatType((CFNumberRef)value) &&
    CFNumberGetValue((CFNumberRef)value, kCFNumberSInt64Type, out);
}
static bool text(CFTypeRef value, char *out, size_t length, bool uuid) {
  if (!value || CFGetTypeID(value) != CFStringGetTypeID() || CFStringGetLength((CFStringRef)value) != (CFIndex)length ||
      !CFStringGetCString((CFStringRef)value, out, (CFIndex)length + 1, kCFStringEncodingASCII)) return false;
  for (size_t index = 0; index < length; index++) {
    char c = out[index];
    if (uuid && (index == 8 || index == 13 || index == 18 || index == 23)) { if (c != '-') return false; }
    else if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}
bool general_parse_assignment(const unsigned char *bytes, size_t size, uint32_t expected_uid,
    const char *expected_installation, general_assignment *assignment) {
  if (!bytes || !assignment || !expected_installation || expected_uid == 0 || expected_uid == UINT32_MAX ||
      size > GENERAL_ASSIGNMENT_MAX_BYTES || !general_plist_dictionary_count(bytes, size, 10)) return false;
  CFDataRef data = CFDataCreate(NULL, bytes, (CFIndex)size);
  if (!data) return false;
  CFPropertyListFormat format = 0;
  CFPropertyListRef value = CFPropertyListCreateWithData(NULL, data, kCFPropertyListImmutable, &format, NULL);
  CFRelease(data);
  if (!value) return false;
  bool ok = false;
  general_assignment parsed = {0};
  if (format != kCFPropertyListBinaryFormat_v1_0 || CFGetTypeID(value) != CFDictionaryGetTypeID()) goto done;
  CFDictionaryRef row = (CFDictionaryRef)value;
  if (CFDictionaryGetCount(row) != 10) goto done;
  CFTypeRef marker = CFDictionaryGetValue(row, CFSTR("format"));
  int64_t version = 0, uid = 0, policy = 0;
  char policy_digest[65];
  if (!marker || CFGetTypeID(marker) != CFStringGetTypeID() || !CFEqual(marker, CFSTR("koincode-general-wallet-assignment")) ||
      !number(CFDictionaryGetValue(row, CFSTR("version")), &version) || version != 1 ||
      !number(CFDictionaryGetValue(row, CFSTR("uid")), &uid) || uid != expected_uid ||
      !number(CFDictionaryGetValue(row, CFSTR("signingPolicyVersion")), &policy) || policy != 3 ||
      !text(CFDictionaryGetValue(row, CFSTR("signingPolicyDigest")), policy_digest, 64, false) ||
      strcmp(policy_digest, signing_policy_digest) != 0 ||
      !text(CFDictionaryGetValue(row, CFSTR("enrollmentId")), parsed.enrollment_id, 36, true) ||
      !text(CFDictionaryGetValue(row, CFSTR("installationId")), parsed.installation_id, 36, true) ||
      strcmp(parsed.installation_id, expected_installation) != 0 ||
      !text(CFDictionaryGetValue(row, CFSTR("ownerId")), parsed.owner_id, 36, true) ||
      !text(CFDictionaryGetValue(row, CFSTR("initializationId")), parsed.initialization_id, 36, true) ||
      !text(CFDictionaryGetValue(row, CFSTR("initializationDigest")), parsed.initialization_digest, 64, false)) goto done;
  parsed.uid = expected_uid;
  *assignment = parsed; ok = true;
done:
  CFRelease(value); return ok;
}

static bool raw_text(const char *value, size_t length, bool uuid) {
  if (strnlen(value, length + 1) != length) return false;
  for (size_t i = 0; i < length; i++) {
    if (uuid && (i == 8 || i == 13 || i == 18 || i == 23)) { if (value[i] != '-') return false; }
    else if (!((value[i] >= '0' && value[i] <= '9') || (value[i] >= 'a' && value[i] <= 'f'))) return false;
  }
  return true;
}
bool general_encode_assignment(const general_assignment *assignment, unsigned char *out, size_t capacity, size_t *size) {
  if (!assignment || !out || !size || !assignment->uid || assignment->uid == UINT32_MAX ||
      !raw_text(assignment->enrollment_id, 36, true) || !raw_text(assignment->installation_id, 36, true) ||
      !raw_text(assignment->owner_id, 36, true) || !raw_text(assignment->initialization_id, 36, true) || !raw_text(assignment->initialization_digest, 64, false)) return false;
  const void *keys[] = { CFSTR("format"), CFSTR("version"), CFSTR("uid"), CFSTR("enrollmentId"), CFSTR("installationId"), CFSTR("ownerId"),
    CFSTR("initializationId"), CFSTR("initializationDigest"), CFSTR("signingPolicyVersion"), CFSTR("signingPolicyDigest") };
  int64_t version = 1, uid = assignment->uid, policy = 2;
  CFTypeRef values[] = { CFSTR("koincode-general-wallet-assignment"), CFNumberCreate(NULL, kCFNumberSInt64Type, &version),
    CFNumberCreate(NULL, kCFNumberSInt64Type, &uid), CFStringCreateWithCString(NULL, assignment->enrollment_id, kCFStringEncodingASCII),
    CFStringCreateWithCString(NULL, assignment->installation_id, kCFStringEncodingASCII), CFStringCreateWithCString(NULL, assignment->owner_id, kCFStringEncodingASCII),
    CFStringCreateWithCString(NULL, assignment->initialization_id, kCFStringEncodingASCII), CFStringCreateWithCString(NULL, assignment->initialization_digest, kCFStringEncodingASCII),
    CFNumberCreate(NULL, kCFNumberSInt64Type, &policy), CFStringCreateWithCString(NULL, signing_policy_digest, kCFStringEncodingASCII) };
  bool valid = true, ok = false;
  for (unsigned i = 0; i < sizeof(values) / sizeof(*values); i++) if (!values[i]) valid = false;
  CFDictionaryRef row = valid ? CFDictionaryCreate(NULL, keys, (const void **)values, 10, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks) : NULL;
  CFDataRef data = row ? CFPropertyListCreateData(NULL, row, kCFPropertyListBinaryFormat_v1_0, 0, NULL) : NULL;
  if (data && CFDataGetLength(data) > 0 && CFDataGetLength(data) <= GENERAL_ASSIGNMENT_MAX_BYTES && (uint64_t)CFDataGetLength(data) <= capacity) {
    size_t length = (size_t)CFDataGetLength(data); general_assignment parsed;
    if (general_parse_assignment(CFDataGetBytePtr(data), length, assignment->uid, assignment->installation_id, &parsed) &&
        !strcmp(parsed.enrollment_id, assignment->enrollment_id) && !strcmp(parsed.owner_id, assignment->owner_id) &&
        !strcmp(parsed.initialization_id, assignment->initialization_id) && !strcmp(parsed.initialization_digest, assignment->initialization_digest)) {
      memcpy(out, CFDataGetBytePtr(data), length); *size = length; ok = true;
    }
  }
  if (data) CFRelease(data); if (row) CFRelease(row);
  for (unsigned i = 1; i < sizeof(values) / sizeof(*values); i++) if (values[i]) CFRelease(values[i]);
  return ok;
}
