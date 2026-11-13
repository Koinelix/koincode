#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#include <Security/Security.h>
#include <string.h>
#include <unistd.h>
#include "native-anchor.h"

static CFStringRef const service = CFSTR("dev.koincode.wallet.general.protected.v1");
static bool installation_valid(const general_native_identity *identity, const general_session_installation *installation) {
  if (!general_native_identity_valid(identity) || identity->uid != geteuid() || !installation ||
      strnlen(installation->installation_id, 37) != 36 || strcmp(identity->installation_id, installation->installation_id) ||
      installation->revision < 1 || (uint64_t)installation->revision > GENERAL_SESSION_SAFE_INTEGER_MAX || strnlen(installation->team_id, 11) != 10) return false;
  unsigned host = 0, broker = 0;
  for (unsigned i = 0; i < 20; i++) { host |= installation->host_hash[i]; broker |= installation->broker_hash[i]; }
  if (!host || !broker) return false;
  for (unsigned i = 0; i < 10; i++) {
    char c = installation->team_id[i]; if (!(c >= 'A' && c <= 'Z') && !(c >= '0' && c <= '9')) return false;
  }
  char group[sizeof(installation->keychain_access_group)];
  int size = snprintf(group, sizeof(group), "%s%s", installation->team_id, GENERAL_SESSION_ACCESS_GROUP_SUFFIX);
  return size > 0 && size < (int)sizeof(group) && strnlen(installation->keychain_access_group, sizeof(group)) == (size_t)size &&
    !memcmp(group, installation->keychain_access_group, (size_t)size);
}
static CFMutableDictionaryRef query(const general_native_identity *identity, const general_session_installation *installation, LAContext *auth, bool returning) {
  char account[80]; int size = snprintf(account, sizeof(account), "e:%s:native-head-v1", identity->enrollment_id);
  if (size < 1 || size >= (int)sizeof(account)) return NULL;
  CFStringRef account_value = CFStringCreateWithCString(kCFAllocatorDefault, account, kCFStringEncodingUTF8);
  CFStringRef group = CFStringCreateWithCString(kCFAllocatorDefault, installation->keychain_access_group, kCFStringEncodingUTF8);
  CFMutableDictionaryRef out = account_value && group ? CFDictionaryCreateMutable(kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks) : NULL;
  if (out) {
    CFDictionarySetValue(out, kSecClass, kSecClassGenericPassword);
    CFDictionarySetValue(out, kSecUseDataProtectionKeychain, kCFBooleanTrue);
    CFDictionarySetValue(out, kSecAttrService, service);
    CFDictionarySetValue(out, kSecAttrAccessGroup, group);
    CFDictionarySetValue(out, kSecAttrAccount, account_value);
    CFDictionarySetValue(out, kSecAttrSynchronizable, kCFBooleanFalse);
    CFDictionarySetValue(out, kSecAttrAccessible, kSecAttrAccessibleWhenUnlockedThisDeviceOnly);
    CFDictionarySetValue(out, kSecUseAuthenticationContext, (__bridge CFTypeRef)auth);
    if (returning) {
      CFDictionarySetValue(out, kSecMatchLimit, kSecMatchLimitOne);
      CFDictionarySetValue(out, kSecReturnAttributes, kCFBooleanTrue);
      CFDictionarySetValue(out, kSecReturnData, kCFBooleanTrue);
    }
  }
  if (account_value) CFRelease(account_value); if (group) CFRelease(group);
  return out;
}
static bool equal_attribute(CFDictionaryRef record, CFDictionaryRef match, CFStringRef key) {
  CFTypeRef actual = CFDictionaryGetValue(record, key), expected = CFDictionaryGetValue(match, key);
  return actual && expected && CFEqual(actual, expected);
}
static bool parse(CFTypeRef result, CFDictionaryRef match, const general_native_identity *identity, general_native_head *out) {
  if (!result || CFGetTypeID(result) != CFDictionaryGetTypeID()) return false;
  CFDictionaryRef record = (CFDictionaryRef)result;
  CFStringRef keys[] = { kSecAttrAccount, kSecAttrService, kSecAttrAccessGroup, kSecAttrAccessible };
  for (unsigned i = 0; i < sizeof(keys) / sizeof(keys[0]); i++) if (!equal_attribute(record, match, keys[i])) return false;
  CFTypeRef sync = CFDictionaryGetValue(record, kSecAttrSynchronizable);
  if (sync && (CFGetTypeID(sync) != CFBooleanGetTypeID() || !CFEqual(sync, kCFBooleanFalse))) return false;
  CFTypeRef value = CFDictionaryGetValue(record, kSecValueData);
  if (!value || CFGetTypeID(value) != CFDataGetTypeID() || CFDataGetLength(value) < 1 || CFDataGetLength(value) > GENERAL_NATIVE_HEAD_MAX) return false;
  general_native_head parsed;
  if (!general_native_head_parse(CFDataGetBytePtr(value), (size_t)CFDataGetLength(value), &parsed) || !general_native_head_same_identity(&parsed, identity)) return false;
  *out = parsed; return true;
}
static general_native_anchor_status read_head(const general_native_identity *identity, const general_session_installation *installation,
  bool (*current)(void *), void *context, general_native_head *out) {
  if (!out || !current || !installation_valid(identity, installation)) return GENERAL_NATIVE_ANCHOR_INVALID;
  if (!current(context)) return GENERAL_NATIVE_ANCHOR_UNAVAILABLE;
  LAContext *auth = [[LAContext alloc] init]; auth.interactionNotAllowed = YES;
  CFMutableDictionaryRef match = auth ? query(identity, installation, auth, true) : NULL;
  if (!match) { [auth invalidate]; return GENERAL_NATIVE_ANCHOR_UNAVAILABLE; }
  CFTypeRef result = NULL;
  OSStatus status = current(context) ? SecItemCopyMatching(match, &result) : errSecInteractionNotAllowed;
  [auth invalidate];
  general_native_head parsed;
  general_native_anchor_status outcome = GENERAL_NATIVE_ANCHOR_UNAVAILABLE;
  if (current(context)) {
    if (status == errSecItemNotFound) outcome = GENERAL_NATIVE_ANCHOR_MISSING;
    else if (status == errSecSuccess) outcome = parse(result, match, identity, &parsed) ? GENERAL_NATIVE_ANCHOR_FOUND : GENERAL_NATIVE_ANCHOR_INVALID;
  }
  if (result) CFRelease(result); CFRelease(match);
  if (!current(context)) return GENERAL_NATIVE_ANCHOR_UNAVAILABLE;
  if (outcome == GENERAL_NATIVE_ANCHOR_FOUND) *out = parsed;
  return outcome;
}
general_native_anchor_status general_native_anchor_read(const general_native_identity *identity, const general_session_installation *installation,
  bool (*current)(void *), void *context, general_native_head *out) {
  @autoreleasepool { return read_head(identity, installation, current, context, out); }
}
static bool same_head(const general_native_head *a, const general_native_head *b) {
  return general_native_head_same_identity(a, &b->identity) && a->sequence == b->sequence && !strcmp(a->head_digest, b->head_digest);
}
general_native_anchor_write general_native_anchor_advance(const general_native_head *expected, const general_native_event *event,
  const general_session_installation *installation, bool (*current)(void *), void *context) {
  @autoreleasepool {
    if (!current || !general_native_head_valid(expected) || !general_native_event_valid(event) || expected->sequence >= GENERAL_NATIVE_EVENT_LIMIT ||
        event->sequence != expected->sequence + 1 || strcmp(event->previous_digest, expected->head_digest) || !installation_valid(&expected->identity, installation)) return GENERAL_NATIVE_ANCHOR_REJECTED;
    general_native_head actual;
    if (read_head(&expected->identity, installation, current, context, &actual) != GENERAL_NATIVE_ANCHOR_FOUND || !same_head(&actual, expected)) return GENERAL_NATIVE_ANCHOR_REJECTED;
    general_native_head next = *expected; next.sequence = event->sequence;
    unsigned char encoded[GENERAL_NATIVE_HEAD_MAX]; size_t size;
    if (!general_native_event_digest(event, next.head_digest) || !general_native_head_encode(&next, encoded, sizeof(encoded), &size)) return GENERAL_NATIVE_ANCHOR_REJECTED;
    LAContext *auth = [[LAContext alloc] init]; auth.interactionNotAllowed = YES;
    CFMutableDictionaryRef match = auth ? query(&expected->identity, installation, auth, false) : NULL;
    CFDataRef value = CFDataCreate(kCFAllocatorDefault, encoded, (CFIndex)size);
    const void *keys[] = { kSecValueData }, *values[] = { value };
    CFDictionaryRef update = value ? CFDictionaryCreate(kCFAllocatorDefault, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks) : NULL;
    if (!match || !update || !current(context)) {
      if (match) CFRelease(match); if (update) CFRelease(update); if (value) CFRelease(value); [auth invalidate];
      return GENERAL_NATIVE_ANCHOR_REJECTED;
    }
    OSStatus status = SecItemUpdate(match, update);
    CFRelease(match); CFRelease(update); CFRelease(value); [auth invalidate];
    if (status != errSecSuccess || !current(context) || read_head(&expected->identity, installation, current, context, &actual) != GENERAL_NATIVE_ANCHOR_FOUND ||
        !same_head(&actual, &next) || !current(context)) return GENERAL_NATIVE_ANCHOR_UNCERTAIN;
    return GENERAL_NATIVE_ANCHOR_ADVANCED;
  }
}
