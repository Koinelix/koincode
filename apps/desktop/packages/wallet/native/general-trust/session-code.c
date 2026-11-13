#include "session-code.h"
#include "session-canonical.h"
#include <Kernel/kern/cs_blobs.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>

static const char *const paths[] = {
  "/Library/KoinCodeProtectedWallet/WalletHost.app",
  "/Library/KoinCodeProtectedWallet/WalletHost.app/Contents/Helpers/GeneralProtectionBroker.app",
  "/Library/KoinCodeProtectedWallet/GeneralWalletProvisioner",
  "/Library/KoinCodeProtectedWallet/WalletHost.app/Contents/Helpers/GeneralPaymentOwner.app"
};
static const char *const identifiers[] = { "dev.koincode.wallet.host", "dev.koincode.wallet.protection", "dev.koincode.wallet.provisioner", "dev.koincode.wallet.payment-owner" };
static bool string(CFTypeRef value, const char *expected) {
  char bytes[PATH_MAX];
  return value && CFGetTypeID(value) == CFStringGetTypeID() && CFStringGetLength(value) == (CFIndex)strlen(expected) &&
    CFStringGetCString(value, bytes, sizeof(bytes), kCFStringEncodingUTF8) && !strcmp(bytes, expected);
}
static bool integer(CFTypeRef value, int64_t *out) {
  return value && CFGetTypeID(value) == CFNumberGetTypeID() && !CFNumberIsFloatType(value) && CFNumberGetValue(value, kCFNumberSInt64Type, out);
}
static bool receipt_valid(const general_session_installation *receipt) {
  if (!receipt || !memchr(receipt->installation_id, 0, sizeof(receipt->installation_id)) || !general_session_uuid_valid(receipt->installation_id) ||
      receipt->revision < 1 || receipt->revision > (int64_t)GENERAL_SESSION_SAFE_INTEGER_MAX || receipt->team_id[10]) return false;
  for (unsigned i = 0; i < 10; i++) if (!((receipt->team_id[i] >= 'A' && receipt->team_id[i] <= 'Z') || (receipt->team_id[i] >= '0' && receipt->team_id[i] <= '9'))) return false;
  char group[sizeof(receipt->keychain_access_group)];
  int count = snprintf(group, sizeof(group), "%s%s", receipt->team_id, GENERAL_SESSION_ACCESS_GROUP_SUFFIX);
  return count > 0 && count < (int)sizeof(group) && memchr(receipt->keychain_access_group, 0, sizeof(receipt->keychain_access_group)) && !strcmp(group, receipt->keychain_access_group);
}
/* Receipt v2 anchors the outer Host. The additional role must be sealed by that
 * exact installed Host, not by a hash or approved flag from the control client.
 * For running code, compare its actual cdhash with that sealed nested code. */
static bool payment_owner_sealed(CFDictionaryRef running, const general_session_installation *receipt, bool dynamic) {
  if (!general_session_code_distribution(GENERAL_CODE_HOST, receipt)) return false;
  if (!dynamic) return true;
  CFURLRef url = CFURLCreateFromFileSystemRepresentation(NULL, (const UInt8 *)paths[GENERAL_CODE_PAYMENT_OWNER], strlen(paths[GENERAL_CODE_PAYMENT_OWNER]), true);
  SecStaticCodeRef code = NULL; CFDictionaryRef info = NULL; bool valid = false;
  if (url && SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code) == errSecSuccess && code &&
      SecCodeCopySigningInformation(code, kSecCSSigningInformation, &info) == errSecSuccess && info && CFGetTypeID(info) == CFDictionaryGetTypeID()) {
    CFTypeRef expected = CFDictionaryGetValue(info, kSecCodeInfoUnique), actual = CFDictionaryGetValue(running, kSecCodeInfoUnique);
    valid = expected && actual && CFGetTypeID(expected) == CFDataGetTypeID() && CFGetTypeID(actual) == CFDataGetTypeID() &&
      CFDataGetLength(expected) == 20 && CFDataGetLength(actual) == 20 && CFEqual(expected, actual);
  }
  if (info) CFRelease(info);
  if (code) CFRelease(code);
  if (url) CFRelease(url);
  return valid;
}
static bool entitlements(CFDictionaryRef info, general_session_code_role role, const general_session_installation *receipt) {
  CFTypeRef value = CFDictionaryGetValue(info, kSecCodeInfoEntitlementsDict);
  if (!value) return role != GENERAL_CODE_BROKER;
  if (CFGetTypeID(value) != CFDictionaryGetTypeID()) return false;
  CFDictionaryRef dictionary = value;
  const CFStringRef denied[] = {
    CFSTR("com.apple.security.get-task-allow"), CFSTR("get-task-allow"), CFSTR("com.apple.security.cs.disable-library-validation"),
    CFSTR("com.apple.security.cs.allow-dyld-environment-variables"), CFSTR("com.apple.security.cs.allow-unsigned-executable-memory"),
    CFSTR("com.apple.security.cs.disable-executable-page-protection"), CFSTR("com.apple.security.cs.debugger"), CFSTR("com.apple.private.security.clear-library-validation")
  };
  for (unsigned i = 0; i < sizeof(denied) / sizeof(denied[0]); i++) {
    CFTypeRef flag = CFDictionaryGetValue(dictionary, denied[i]);
    if (flag && flag != kCFBooleanFalse) return false;
  }
  CFTypeRef groups = CFDictionaryGetValue(dictionary, CFSTR("keychain-access-groups"));
  if (role != GENERAL_CODE_BROKER) return !groups;
  char application[128];
  int count = snprintf(application, sizeof(application), "%s.%s", receipt->team_id, identifiers[role]);
  return count > 0 && count < (int)sizeof(application) && groups && CFGetTypeID(groups) == CFArrayGetTypeID() && CFArrayGetCount(groups) == 1 &&
    string(CFArrayGetValueAtIndex(groups, 0), receipt->keychain_access_group) &&
    string(CFDictionaryGetValue(dictionary, CFSTR("com.apple.application-identifier")), application) &&
    string(CFDictionaryGetValue(dictionary, CFSTR("com.apple.developer.team-identifier")), receipt->team_id);
}
static bool matches(SecStaticCodeRef code, general_session_code_role role, const general_session_installation *receipt, bool dynamic) {
  if (!code || role < GENERAL_CODE_HOST || role > GENERAL_CODE_PAYMENT_OWNER || !receipt_valid(receipt)) return false;
  char text[768];
  int count = snprintf(text, sizeof(text), "anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"%s\" and identifier \"%s\"", receipt->team_id, identifiers[role]);
  if (count < 1 || count >= (int)sizeof(text)) return false;
  CFStringRef requirement_text = CFStringCreateWithCString(NULL, text, kCFStringEncodingUTF8);
  if (!requirement_text) return false;
  SecRequirementRef requirement = NULL; CFDictionaryRef info = NULL; CFURLRef url = NULL;
  bool valid = false;
  if (SecRequirementCreateWithString(requirement_text, kSecCSDefaultFlags, &requirement) != errSecSuccess || !requirement ||
      (dynamic ? SecCodeCheckValidity((SecCodeRef)code, kSecCSStrictValidate, requirement) :
        SecStaticCodeCheckValidity(code, kSecCSStrictValidate | kSecCSCheckAllArchitectures | kSecCSCheckNestedCode, requirement)) != errSecSuccess ||
      SecCodeCopySigningInformation(code, kSecCSSigningInformation | (dynamic ? kSecCSDynamicInformation : 0), &info) != errSecSuccess || !info || CFGetTypeID(info) != CFDictionaryGetTypeID()) goto done;
  int64_t flags, status;
  if (!string(CFDictionaryGetValue(info, kSecCodeInfoIdentifier), identifiers[role]) || !string(CFDictionaryGetValue(info, kSecCodeInfoTeamIdentifier), receipt->team_id) ||
      !integer(CFDictionaryGetValue(info, kSecCodeInfoFlags), &flags) || !(flags & kSecCodeSignatureRuntime) || (flags & kSecCodeSignatureAdhoc) ||
      !entitlements(info, role, receipt)) goto done;
  /* A declared access group is not OS authorization. This kernel-derived bit
   * is necessary for the broker, but not a complete profile lifetime proof. */
  if (dynamic && (!integer(CFDictionaryGetValue(info, kSecCodeInfoStatus), &status) || status < 0 || status > UINT32_MAX ||
      !(status & kSecCodeStatusValid) || (status & kSecCodeStatusDebugged) ||
      (role == GENERAL_CODE_BROKER && !(status & CS_ENTITLEMENTS_VALIDATED)))) goto done;
  if (role == GENERAL_CODE_PAYMENT_OWNER) {
    if (!payment_owner_sealed(info, receipt, dynamic)) goto done;
  } else if (role != GENERAL_CODE_PROVISIONER) {
    CFTypeRef hash = CFDictionaryGetValue(info, kSecCodeInfoUnique);
    if (!hash || CFGetTypeID(hash) != CFDataGetTypeID() || CFDataGetLength(hash) != 20 || memcmp(CFDataGetBytePtr(hash), role == GENERAL_CODE_HOST ? receipt->host_hash : receipt->broker_hash, 20)) goto done;
  }
  char path[PATH_MAX];
  valid = SecCodeCopyPath(code, kSecCSDefaultFlags, &url) == errSecSuccess && url && CFGetTypeID(url) == CFURLGetTypeID() &&
    CFURLGetFileSystemRepresentation(url, true, (UInt8 *)path, sizeof(path)) && !strcmp(path, paths[role]);
done:
  if (url) CFRelease(url);
  if (info) CFRelease(info);
  if (requirement) CFRelease(requirement);
  CFRelease(requirement_text); return valid;
}
bool general_session_code_matches(SecCodeRef code, general_session_code_role role, const general_session_installation *receipt) {
  return matches((SecStaticCodeRef)code, role, receipt, true);
}
bool general_session_code_self(general_session_code_role role, const general_session_installation *receipt) {
  SecCodeRef code = NULL;
  bool valid = SecCodeCopySelf(kSecCSDefaultFlags, &code) == errSecSuccess && code && general_session_code_matches(code, role, receipt);
  if (code) CFRelease(code);
  return valid;
}
bool general_session_code_distribution(general_session_code_role role, const general_session_installation *receipt) {
  if (role < GENERAL_CODE_HOST || role > GENERAL_CODE_PAYMENT_OWNER || !receipt_valid(receipt)) return false;
  CFURLRef url = CFURLCreateFromFileSystemRepresentation(NULL, (const UInt8 *)paths[role], strlen(paths[role]), role != GENERAL_CODE_PROVISIONER);
  if (!url) return false;
  SecStaticCodeRef code = NULL;
  bool valid = SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code) == errSecSuccess && code && matches(code, role, receipt, false);
  if (code) CFRelease(code);
  CFRelease(url); return valid;
}
