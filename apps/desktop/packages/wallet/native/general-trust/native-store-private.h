#ifndef KOINCODE_GENERAL_NATIVE_STORE_PRIVATE_H
#define KOINCODE_GENERAL_NATIVE_STORE_PRIVATE_H
#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#include "native-record.h"
#include <Security/Security.h>
#include <CommonCrypto/CommonDigest.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
/* Fixed DP namespace/attribute recipes only. Callers independently retain the
 * genuine original peer, scope, authenticated command and accepted prefix. */
static bool general_store_installation_valid(const general_native_identity *identity, const general_session_installation *installation) {
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
static CFMutableDictionaryRef general_store_query(const general_native_identity *identity, const general_session_installation *installation,
    const char *profile, const char *reference, LAContext *auth) {
  char account[192];
  int size = profile ? snprintf(account, sizeof(account), "e:%s:p:%s:%s", identity->enrollment_id, profile, reference) :
    snprintf(account, sizeof(account), "e:%s:%s", identity->enrollment_id, reference);
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
static CFDataRef general_store_body(CFTypeRef result, CFDictionaryRef match, const char expected[65]) {
  if (!result || CFGetTypeID(result) != CFDictionaryGetTypeID()) return NULL;
  CFDictionaryRef record = result;
  const CFStringRef keys[] = { kSecAttrAccount, kSecAttrService, kSecAttrAccessGroup, kSecAttrAccessible };
  for (size_t i = 0; i < sizeof(keys) / sizeof(keys[0]); i++) {
    CFTypeRef value = CFDictionaryGetValue(record, keys[i]); if (!value || !CFEqual(value, CFDictionaryGetValue(match, keys[i]))) return NULL;
  }
  CFTypeRef sync = CFDictionaryGetValue(record, kSecAttrSynchronizable), value = CFDictionaryGetValue(record, kSecValueData);
  if ((sync && (CFGetTypeID(sync) != CFBooleanGetTypeID() || !CFEqual(sync, kCFBooleanFalse))) || !value || CFGetTypeID(value) != CFDataGetTypeID() ||
      CFDataGetLength(value) < 1 || CFDataGetLength(value) > GENERAL_SESSION_VALUE_MAX) return NULL;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH]; char hex[65]; const char alphabet[] = "0123456789abcdef";
  if (!CC_SHA256(CFDataGetBytePtr(value), (CC_LONG)CFDataGetLength(value), digest)) return NULL;
  for (unsigned i = 0; i < sizeof(digest); i++) { hex[i * 2] = alphabet[digest[i] >> 4]; hex[i * 2 + 1] = alphabet[digest[i] & 15]; } hex[64] = 0;
  return strcmp(hex, expected) ? NULL : value;
}
#endif
