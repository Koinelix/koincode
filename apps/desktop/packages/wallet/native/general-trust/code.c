#include "trust.h"
#include <limits.h>
#include <string.h>
#include <unistd.h>

static bool safe_entitlements(CFDictionaryRef info) {
  CFTypeRef value = CFDictionaryGetValue(info, kSecCodeInfoEntitlementsDict);
  if (!value) return true;
  if (CFGetTypeID(value) != CFDictionaryGetTypeID()) return false;
  const CFStringRef denied[] = {
    CFSTR("com.apple.security.get-task-allow"), CFSTR("get-task-allow"),
    CFSTR("com.apple.security.cs.disable-library-validation"),
    CFSTR("com.apple.security.cs.allow-dyld-environment-variables"),
    CFSTR("com.apple.security.cs.allow-unsigned-executable-memory"),
    CFSTR("com.apple.security.cs.disable-executable-page-protection"),
    CFSTR("com.apple.security.cs.debugger"), CFSTR("com.apple.private.security.clear-library-validation"),
  };
  for (size_t i = 0; i < sizeof(denied) / sizeof(denied[0]); i++) {
    CFTypeRef flag = CFDictionaryGetValue((CFDictionaryRef)value, denied[i]);
    if (flag && flag != kCFBooleanFalse) return false;
  }
  return true;
}

bool general_matches_code(SecStaticCodeRef code, const char *path, const char *identifier,
  const unsigned char hash[20], bool dynamic) {
  if (!code || !path || !identifier || !hash) return false;
  if (dynamic && SecCodeCheckValidity((SecCodeRef)code, kSecCSStrictValidate, NULL) != errSecSuccess) return false;
  CFDictionaryRef info = NULL;
  if (SecCodeCopySigningInformation(code, kSecCSSigningInformation | (dynamic ? kSecCSDynamicInformation : 0), &info) != errSecSuccess || !info) return false;
  bool ok = false;
  CFURLRef url = NULL;
  CFTypeRef name = CFDictionaryGetValue(info, kSecCodeInfoIdentifier);
  CFTypeRef unique = CFDictionaryGetValue(info, kSecCodeInfoUnique);
  CFTypeRef flags = CFDictionaryGetValue(info, kSecCodeInfoFlags);
  char actual_id[256], actual_path[PATH_MAX]; int64_t bits = 0;
  if (!name || CFGetTypeID(name) != CFStringGetTypeID() ||
      !CFStringGetCString((CFStringRef)name, actual_id, sizeof(actual_id), kCFStringEncodingUTF8) || strcmp(actual_id, identifier) != 0 ||
      !unique || CFGetTypeID(unique) != CFDataGetTypeID() || CFDataGetLength((CFDataRef)unique) != 20 ||
      memcmp(CFDataGetBytePtr((CFDataRef)unique), hash, 20) != 0 ||
      !flags || CFGetTypeID(flags) != CFNumberGetTypeID() || !CFNumberGetValue((CFNumberRef)flags, kCFNumberSInt64Type, &bits) ||
      !(bits & kSecCodeSignatureRuntime) || !safe_entitlements(info) ||
      SecCodeCopyPath(code, kSecCSDefaultFlags, &url) != errSecSuccess || !url ||
      !CFURLGetFileSystemRepresentation(url, true, (UInt8 *)actual_path, sizeof(actual_path)) || strcmp(actual_path, path) != 0) goto done;
  if (dynamic) {
    int64_t status = 0; CFTypeRef runtime_status = CFDictionaryGetValue(info, kSecCodeInfoStatus);
    if (!runtime_status || CFGetTypeID(runtime_status) != CFNumberGetTypeID() ||
        !CFNumberGetValue((CFNumberRef)runtime_status, kCFNumberSInt64Type, &status) ||
        !(status & kSecCodeStatusValid) || (status & kSecCodeStatusDebugged)) goto done;
  }
  ok = true;
done:
  if (url) CFRelease(url);
  CFRelease(info); return ok;
}

bool general_bundle_is_valid(void) {
  if (!general_bundle_tree_protected()) return false;
  int fd = general_protected_open(GENERAL_TRUST_HOST, true);
  if (fd < 0) return false;
  close(fd);
  CFURLRef url = CFURLCreateFromFileSystemRepresentation(NULL, (const UInt8 *)GENERAL_TRUST_HOST, strlen(GENERAL_TRUST_HOST), true);
  if (!url) return false;
  SecStaticCodeRef code = NULL;
  OSStatus result = SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code);
  if (result == errSecSuccess) result = SecStaticCodeCheckValidity(code,
    kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode, NULL);
  if (code) CFRelease(code);
  CFRelease(url); return result == errSecSuccess;
}
