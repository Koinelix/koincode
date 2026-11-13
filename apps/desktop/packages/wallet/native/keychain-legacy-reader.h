#ifndef KOINCODE_KEYCHAIN_LEGACY_READER_H
#define KOINCODE_KEYCHAIN_LEGACY_READER_H
#include <dlfcn.h>

/* This compatibility API is optional. Missing support must not launch a reader. */
typedef OSStatus (*wallet_copy_requirement)(SecTrustedApplicationRef, SecRequirementRef *);
static int wallet_legacy_trust(SecKeychainItemRef item, SecStaticCodeRef code) {
  wallet_copy_requirement copy = (wallet_copy_requirement)dlsym(RTLD_DEFAULT, "SecTrustedApplicationCopyRequirement");
  if (!copy) return 0;
  SecAccessRef access = NULL; CFArrayRef acls = NULL; int matched = 0;
  if (SecKeychainItemCopyAccess(item, &access)) return 0;
  acls = SecAccessCopyMatchingACLList(access, kSecACLAuthorizationDecrypt);
  if (acls) for (CFIndex i = 0; i < CFArrayGetCount(acls) && !matched; i++) {
    CFArrayRef apps = NULL; CFStringRef label = NULL; SecKeychainPromptSelector prompt = 0;
    if (!SecACLCopyContents((SecACLRef)CFArrayGetValueAtIndex(acls, i), &apps, &label, &prompt) && apps) {
      for (CFIndex j = 0; j < CFArrayGetCount(apps) && !matched; j++) {
        SecRequirementRef requirement = NULL;
        if (!copy((SecTrustedApplicationRef)CFArrayGetValueAtIndex(apps, j), &requirement) && requirement) {
          matched = SecStaticCodeCheckValidity(code, kSecCSCheckAllArchitectures, requirement) == errSecSuccess;
          CFRelease(requirement);
        }
      }
    }
    if (apps) CFRelease(apps);
    if (label) CFRelease(label);
  }
  if (acls) CFRelease(acls);
  CFRelease(access); return matched;
}
static int wallet_legacy_exchange(const char *executable, const char *operation,
                                  const char *account, CFDictionaryRef query, CFStringRef anchor) {
  char reader[PATH_MAX], library[PATH_MAX];
  if (!realpath(executable, reader)) return 74;
  char *name = strrchr(reader, '/'); if (!name) return 74;
  char filename[128]; if (strlen(name + 1) >= sizeof(filename)) return 74;
  strcpy(filename, name + 1); *name = 0;
  if (snprintf(library, sizeof(library), "%s/legacy-noninteractive.dylib", reader) >= (int)sizeof(library)) return 74;
  char *directory = strrchr(reader, '/');
  if (!directory || strcmp(directory + 1, "user-v2")) return 74;
  strcpy(directory + 1, filename);
  struct stat info;
  if (lstat(reader, &info) || !S_ISREG(info.st_mode) || (info.st_mode & 06022) || info.st_uid != getuid()) return 79;
  if (lstat(library, &info) || !S_ISREG(info.st_mode) || (info.st_mode & 0022) || (info.st_uid != getuid() && info.st_uid != 0)) return 79;
  CFURLRef url = CFURLCreateFromFileSystemRepresentation(NULL, (const UInt8 *)reader, strlen(reader), false);
  SecStaticCodeRef code = NULL; CFDictionaryRef signing = NULL;
  OSStatus status = url ? SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code) : errSecParam;
  if (url) CFRelease(url);
  uint32_t flags = 0;
  if (!status) status = SecStaticCodeCheckValidity(code, kSecCSCheckAllArchitectures, NULL);
  if (!status) status = SecCodeCopySigningInformation(code, kSecCSSigningInformation, &signing);
  CFNumberRef storedFlags = signing ? CFDictionaryGetValue(signing, kSecCodeInfoFlags) : NULL;
  if (!storedFlags || !CFNumberGetValue(storedFlags, kCFNumberSInt32Type, &flags) ||
      flags & (kSecCodeSignatureRestrict | kSecCodeSignatureLibraryValidation | kSecCodeSignatureRuntime)) status = errSecAuthFailed;
  if (signing) CFRelease(signing);
  CFMutableDictionaryRef check = CFDictionaryCreateMutableCopy(NULL, 0, query);
  CFDictionarySetValue(check, kSecReturnRef, kCFBooleanTrue);
  CFTypeRef item = NULL;
  if (!status) {
    status = SecItemCopyMatching(check, &item);
    if (status == errSecItemNotFound && !strcmp(operation, "put")) {
      CFDictionarySetValue(check, kSecAttrAccount, anchor);
      status = SecItemCopyMatching(check, &item);
    }
  }
  if (!status && (!item || !wallet_legacy_trust((SecKeychainItemRef)item, code))) status = errSecAuthFailed;
  if (item) CFRelease(item);
  CFRelease(check); if (code) CFRelease(code);
  if (status == errSecItemNotFound) return 44;
  if (status) return 79;
  if (setenv("DYLD_INSERT_LIBRARIES", library, 1)) return 74;
  execl(reader, reader, operation, account, (char *)NULL);
  return 74;
}
#endif
