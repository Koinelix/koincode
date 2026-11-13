#include "registration-record.h"
#include "binary-plist.h"
#include <CoreFoundation/CoreFoundation.h>
#include <string.h>

static const char *const phases[] = { "", "reserved", "head_create_started", "assigned" };
static bool same_identity(const general_native_identity *left, const general_native_identity *right) {
  return left->uid == right->uid && !strcmp(left->enrollment_id, right->enrollment_id) && !strcmp(left->installation_id, right->installation_id) &&
    !strcmp(left->owner_id, right->owner_id) && !strcmp(left->initialization_id, right->initialization_id) && !strcmp(left->initialization_digest, right->initialization_digest);
}
static bool integer(CFTypeRef value, int64_t *out) {
  return value && CFGetTypeID(value) == CFNumberGetTypeID() && !CFNumberIsFloatType((CFNumberRef)value) && CFNumberGetValue((CFNumberRef)value, kCFNumberSInt64Type, out);
}
static bool text(CFTypeRef value, char *out, size_t length) {
  return value && CFGetTypeID(value) == CFStringGetTypeID() && CFStringGetLength((CFStringRef)value) == (CFIndex)length &&
    CFStringGetCString((CFStringRef)value, out, (CFIndex)length + 1, kCFStringEncodingASCII);
}
bool general_registration_record_valid(const general_registration_record *record) {
  return record && general_native_identity_valid(&record->identity) && record->phase >= GENERAL_REGISTRATION_RESERVED && record->phase <= GENERAL_REGISTRATION_ASSIGNED;
}
bool general_registration_record_parse(const unsigned char *bytes, size_t size, general_registration_record *out) {
  if (!out || size > GENERAL_REGISTRATION_RECORD_MAX || !general_plist_dictionary_count(bytes, size, 9)) return false;
  CFDataRef data = CFDataCreate(NULL, bytes, (CFIndex)size); if (!data) return false;
  CFPropertyListFormat format = 0;
  CFPropertyListRef value = CFPropertyListCreateWithData(NULL, data, kCFPropertyListImmutable, &format, NULL); CFRelease(data);
  if (!value) return false;
  general_registration_record parsed = {0}; bool ok = false; int64_t version = 0, uid = 0;
  if (format != kCFPropertyListBinaryFormat_v1_0 || CFGetTypeID(value) != CFDictionaryGetTypeID()) goto done;
  CFDictionaryRef row = (CFDictionaryRef)value; CFTypeRef marker = CFDictionaryGetValue(row, CFSTR("format"));
  if (CFDictionaryGetCount(row) != 9 || !marker || CFGetTypeID(marker) != CFStringGetTypeID() || !CFEqual(marker, CFSTR("koincode-general-wallet-registration")) ||
      !integer(CFDictionaryGetValue(row, CFSTR("version")), &version) || version != 1 ||
      !integer(CFDictionaryGetValue(row, CFSTR("uid")), &uid) || uid < 1 || uid >= UINT32_MAX ||
      !text(CFDictionaryGetValue(row, CFSTR("enrollmentId")), parsed.identity.enrollment_id, 36) ||
      !text(CFDictionaryGetValue(row, CFSTR("installationId")), parsed.identity.installation_id, 36) ||
      !text(CFDictionaryGetValue(row, CFSTR("ownerId")), parsed.identity.owner_id, 36) ||
      !text(CFDictionaryGetValue(row, CFSTR("initializationId")), parsed.identity.initialization_id, 36) ||
      !text(CFDictionaryGetValue(row, CFSTR("initializationDigest")), parsed.identity.initialization_digest, 64)) goto done;
  parsed.identity.uid = (uint32_t)uid;
  CFTypeRef phase = CFDictionaryGetValue(row, CFSTR("phase"));
  if (!phase || CFGetTypeID(phase) != CFStringGetTypeID()) goto done;
  for (unsigned i = 1; i < sizeof(phases) / sizeof(*phases); i++) {
    CFStringRef expected = CFStringCreateWithCString(NULL, phases[i], kCFStringEncodingASCII);
    bool match = expected && CFEqual(phase, expected); if (expected) CFRelease(expected);
    if (match) parsed.phase = (general_registration_phase)i;
  }
  if (!general_registration_record_valid(&parsed)) goto done;
  *out = parsed; ok = true;
done:
  CFRelease(value); return ok;
}
bool general_registration_record_encode(const general_registration_record *record, unsigned char *out, size_t capacity, size_t *size) {
  if (!out || !size || !general_registration_record_valid(record)) return false;
  const general_native_identity *identity = &record->identity;
  const void *keys[] = { CFSTR("format"), CFSTR("version"), CFSTR("uid"), CFSTR("enrollmentId"), CFSTR("installationId"), CFSTR("ownerId"),
    CFSTR("initializationId"), CFSTR("initializationDigest"), CFSTR("phase") };
  int64_t version = 1, uid = identity->uid;
  CFTypeRef values[] = { CFSTR("koincode-general-wallet-registration"), CFNumberCreate(NULL, kCFNumberSInt64Type, &version),
    CFNumberCreate(NULL, kCFNumberSInt64Type, &uid), CFStringCreateWithCString(NULL, identity->enrollment_id, kCFStringEncodingASCII),
    CFStringCreateWithCString(NULL, identity->installation_id, kCFStringEncodingASCII), CFStringCreateWithCString(NULL, identity->owner_id, kCFStringEncodingASCII),
    CFStringCreateWithCString(NULL, identity->initialization_id, kCFStringEncodingASCII), CFStringCreateWithCString(NULL, identity->initialization_digest, kCFStringEncodingASCII),
    CFStringCreateWithCString(NULL, phases[record->phase], kCFStringEncodingASCII) };
  bool valid = true, ok = false;
  for (unsigned i = 0; i < sizeof(values) / sizeof(*values); i++) if (!values[i]) valid = false;
  CFDictionaryRef row = valid ? CFDictionaryCreate(NULL, keys, (const void **)values, 9, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks) : NULL;
  CFDataRef data = row ? CFPropertyListCreateData(NULL, row, kCFPropertyListBinaryFormat_v1_0, 0, NULL) : NULL;
  if (data && CFDataGetLength(data) > 0 && CFDataGetLength(data) <= GENERAL_REGISTRATION_RECORD_MAX && (uint64_t)CFDataGetLength(data) <= capacity) {
    size_t length = (size_t)CFDataGetLength(data); general_registration_record readback;
    if (general_registration_record_parse(CFDataGetBytePtr(data), length, &readback) && readback.phase == record->phase && same_identity(&readback.identity, identity)) {
      memcpy(out, CFDataGetBytePtr(data), length); *size = length; ok = true;
    }
  }
  if (data) CFRelease(data); if (row) CFRelease(row);
  for (unsigned i = 1; i < sizeof(values) / sizeof(*values); i++) if (values[i]) CFRelease(values[i]);
  return ok;
}
bool general_registration_binding_valid(const general_registration_record *record, const general_initialization_plan *plan) {
  if (!general_registration_record_valid(record) || !general_initialization_plan_valid(plan)) return false;
  return same_identity(&record->identity, &plan->identity);
}
bool general_registration_advance_valid(const general_registration_record *before, const general_registration_record *after, const general_initialization_plan *plan) {
  return general_registration_binding_valid(before, plan) && general_registration_binding_valid(after, plan) && (after->phase == before->phase || after->phase == before->phase + 1);
}
