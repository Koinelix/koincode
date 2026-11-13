#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#include "native-binding.h"
#include <Security/Security.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

typedef struct { bool (*current)(void *); void *context; struct timespec started, last; } read_operation;
static bool active(read_operation *op) {
  struct timespec now;
  if (!op->current(op->context) || clock_gettime(CLOCK_MONOTONIC, &now) || now.tv_sec < 0 || now.tv_nsec < 0 || now.tv_nsec >= 1000000000 ||
      now.tv_sec < op->last.tv_sec || (now.tv_sec == op->last.tv_sec && now.tv_nsec < op->last.tv_nsec)) return false;
  op->last = now;
  return now.tv_sec - op->started.tv_sec < 30 || (now.tv_sec - op->started.tv_sec == 30 && now.tv_nsec < op->started.tv_nsec);
}
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
static CFMutableDictionaryRef query(const general_native_identity *identity, const general_session_installation *installation, LAContext *auth) {
  char account[100]; int size = snprintf(account, sizeof(account), "e:%s:general-domain-binding-v1", identity->enrollment_id);
  if (size < 1 || size >= (int)sizeof(account)) return NULL;
  CFStringRef name = CFStringCreateWithCString(NULL, account, kCFStringEncodingASCII);
  CFStringRef group = CFStringCreateWithCString(NULL, installation->keychain_access_group, kCFStringEncodingASCII);
  CFMutableDictionaryRef match = name && group ? CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks) : NULL;
  if (match) {
    CFDictionarySetValue(match, kSecClass, kSecClassGenericPassword);
    CFDictionarySetValue(match, kSecUseDataProtectionKeychain, kCFBooleanTrue);
    CFDictionarySetValue(match, kSecAttrService, CFSTR("dev.koincode.wallet.general.protected.v1"));
    CFDictionarySetValue(match, kSecAttrAccount, name); CFDictionarySetValue(match, kSecAttrAccessGroup, group);
    CFDictionarySetValue(match, kSecAttrAccessible, kSecAttrAccessibleWhenUnlockedThisDeviceOnly);
    CFDictionarySetValue(match, kSecAttrSynchronizable, kCFBooleanFalse);
    CFDictionarySetValue(match, kSecUseAuthenticationContext, (__bridge CFTypeRef)auth);
    CFDictionarySetValue(match, kSecMatchLimit, kSecMatchLimitOne);
    CFDictionarySetValue(match, kSecReturnAttributes, kCFBooleanTrue); CFDictionarySetValue(match, kSecReturnData, kCFBooleanTrue);
  }
  if (name) CFRelease(name); if (group) CFRelease(group); return match;
}
static bool parse(CFTypeRef result, CFDictionaryRef match, const general_native_identity *identity, general_domain_binding *out) {
  if (!result || CFGetTypeID(result) != CFDictionaryGetTypeID()) return false;
  CFDictionaryRef record = result;
  CFStringRef keys[] = { kSecAttrAccount, kSecAttrService, kSecAttrAccessGroup, kSecAttrAccessible };
  for (size_t i = 0; i < sizeof(keys) / sizeof(keys[0]); i++) {
    CFTypeRef value = CFDictionaryGetValue(record, keys[i]);
    if (!value || !CFEqual(value, CFDictionaryGetValue(match, keys[i]))) return false;
  }
  CFTypeRef sync = CFDictionaryGetValue(record, kSecAttrSynchronizable), value = CFDictionaryGetValue(record, kSecValueData);
  if ((sync && (CFGetTypeID(sync) != CFBooleanGetTypeID() || !CFEqual(sync, kCFBooleanFalse))) ||
      !value || CFGetTypeID(value) != CFDataGetTypeID() || CFDataGetLength(value) < 1 || CFDataGetLength(value) > GENERAL_DOMAIN_BINDING_MAX) return false;
  general_domain_binding binding;
  if (!general_domain_binding_parse(CFDataGetBytePtr(value), (size_t)CFDataGetLength(value), &binding) || binding.uid != identity->uid ||
      strcmp(binding.owner_id, identity->owner_id) || strcmp(binding.installation_id, identity->installation_id) || strcmp(binding.enrollment_id, identity->enrollment_id)) return false;
  if (binding.origin == GENERAL_BINDING_NEW && (strcmp(binding.source.created.initialization_id, identity->initialization_id) ||
      strcmp(binding.source.created.initialization_digest, identity->initialization_digest))) return false;
  *out = binding; return true;
}
general_native_anchor_status general_native_binding_read(const general_native_identity *identity,
    const general_session_installation *installation, bool (*current)(void *), void *context, general_domain_binding *out) {
  @autoreleasepool {
    if (!current || !out || !installation_valid(identity, installation)) return GENERAL_NATIVE_ANCHOR_INVALID;
    read_operation op = { .current = current, .context = context };
    if (clock_gettime(CLOCK_MONOTONIC, &op.started) || op.started.tv_sec < 0 || op.started.tv_nsec < 0 || op.started.tv_nsec >= 1000000000) return GENERAL_NATIVE_ANCHOR_UNAVAILABLE;
    op.last = op.started; if (!active(&op)) return GENERAL_NATIVE_ANCHOR_UNAVAILABLE;
    LAContext *auth = [LAContext new]; auth.interactionNotAllowed = YES;
    CFMutableDictionaryRef match = auth ? query(identity, installation, auth) : NULL;
    if (!match) { [auth invalidate]; return GENERAL_NATIVE_ANCHOR_UNAVAILABLE; }
    CFTypeRef result = NULL; general_domain_binding parsed;
    OSStatus status = active(&op) ? SecItemCopyMatching(match, &result) : errSecInteractionNotAllowed;
    [auth invalidate]; general_native_anchor_status outcome = GENERAL_NATIVE_ANCHOR_UNAVAILABLE;
    if (active(&op)) {
      if (status == errSecItemNotFound) outcome = result ? GENERAL_NATIVE_ANCHOR_INVALID : GENERAL_NATIVE_ANCHOR_MISSING;
      else if (status == errSecSuccess) outcome = parse(result, match, identity, &parsed) ? GENERAL_NATIVE_ANCHOR_FOUND : GENERAL_NATIVE_ANCHOR_INVALID;
    }
    if (result) CFRelease(result); CFRelease(match);
    if (!active(&op)) return GENERAL_NATIVE_ANCHOR_UNAVAILABLE;
    if (outcome == GENERAL_NATIVE_ANCHOR_FOUND) *out = parsed;
    return outcome;
  }
}
