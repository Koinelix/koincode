#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <bsm/libbsm.h>
#include <libproc.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

static void json_string(const char *text) {
  putchar('"');
  for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
    if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
    else if (*p < 32) printf("\\u%04x", (unsigned)*p);
    else putchar(*p);
  }
  putchar('"');
}
static bool flag(CFDictionaryRef dict, CFStringRef name) {
  return dict && CFDictionaryGetValue(dict, name) == kCFBooleanTrue;
}
int main(void) {
  alarm(5);
  audit_token_t token;
  socklen_t length = sizeof(token);
  uid_t uid; gid_t gid;
  if (getpeereid(3, &uid, &gid) != 0 || uid != geteuid() ||
      getsockopt(3, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &length) != 0 || length != sizeof(token)) return 74;
  CFDataRef data = CFDataCreate(NULL, (const UInt8 *)&token, sizeof(token));
  const void *keys[] = { kSecGuestAttributeAudit }, *values[] = { data };
  CFDictionaryRef attributes = CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  SecCodeRef code = NULL;
  OSStatus status = SecCodeCopyGuestWithAttributes(NULL, attributes, kSecCSDefaultFlags, &code);
  OSStatus validity = status == errSecSuccess ? SecCodeCheckValidity(code, kSecCSStrictValidate, NULL) : status;
  char identifier[1024] = "", team[256] = "", executable[PROC_PIDPATHINFO_MAXSIZE] = "";
  bool hardened = false, risky = false;
  SecRequirementRef requirement = NULL;
  CFStringRef requirement_text = NULL;
  char requirement_buffer[8192] = "";
  if (status == errSecSuccess) {
    SecStaticCodeRef static_code = NULL;
    CFDictionaryRef info = NULL;
    if (SecCodeCopyStaticCode(code, kSecCSDefaultFlags, &static_code) == errSecSuccess &&
        SecCodeCopySigningInformation(static_code, kSecCSSigningInformation, &info) == errSecSuccess) {
      CFStringRef name = CFDictionaryGetValue(info, kSecCodeInfoIdentifier);
      CFStringRef signing_team = CFDictionaryGetValue(info, kSecCodeInfoTeamIdentifier);
      if (name && CFGetTypeID(name) == CFStringGetTypeID()) if (!CFStringGetCString(name, identifier, sizeof(identifier), kCFStringEncodingUTF8)) identifier[0] = 0;
      if (signing_team && CFGetTypeID(signing_team) == CFStringGetTypeID()) if (!CFStringGetCString(signing_team, team, sizeof(team), kCFStringEncodingUTF8)) team[0] = 0;
      CFNumberRef flags = CFDictionaryGetValue(info, kSecCodeInfoFlags);
      int64_t numeric_flags = 0;
      if (flags && CFGetTypeID(flags) == CFNumberGetTypeID()) CFNumberGetValue(flags, kCFNumberSInt64Type, &numeric_flags);
      hardened = (numeric_flags & kSecCodeSignatureRuntime) != 0;
      CFTypeRef entitlements = CFDictionaryGetValue(info, kSecCodeInfoEntitlementsDict);
      if (entitlements && CFGetTypeID(entitlements) == CFDictionaryGetTypeID()) {
        CFDictionaryRef dict = (CFDictionaryRef)entitlements;
        risky = flag(dict, CFSTR("com.apple.security.get-task-allow")) || flag(dict, CFSTR("com.apple.security.cs.disable-library-validation")) || flag(dict, CFSTR("com.apple.security.cs.allow-dyld-environment-variables"));
      }
      if (SecCodeCopyDesignatedRequirement(code, kSecCSDefaultFlags, &requirement) == errSecSuccess &&
          SecRequirementCopyString(requirement, kSecCSDefaultFlags, &requirement_text) == errSecSuccess)
        if (!CFStringGetCString(requirement_text, requirement_buffer, sizeof(requirement_buffer), kCFStringEncodingUTF8)) requirement_buffer[0] = 0;
      CFRelease(info);
    }
    if (static_code) CFRelease(static_code);
  }
  pid_t pid = audit_token_to_pid(token);
  proc_pidpath(pid, executable, sizeof(executable));
  const char *base = strrchr(executable, '/'); base = base ? base + 1 : executable;
  bool interpreter = strcmp(base, "node") == 0 || strncmp(base, "python", 6) == 0 || strcmp(base, "bun") == 0 || strcmp(base, "deno") == 0 || strcmp(base, "bash") == 0 || strcmp(base, "zsh") == 0 || strcmp(base, "sh") == 0 || strcmp(base, "osascript") == 0 || strstr(base, "Electron") != NULL;
  printf("{\"kernelBound\":true,\"pid\":%d,\"uid\":%u,\"valid\":%s,\"hardened\":%s,\"riskyEntitlements\":%s,\"interpreter\":%s,\"identifier\":", pid, uid, validity == errSecSuccess ? "true" : "false", hardened ? "true" : "false", risky ? "true" : "false", interpreter ? "true" : "false");
  json_string(identifier); fputs(",\"team\":", stdout); json_string(team); fputs(",\"requirement\":", stdout); json_string(requirement_buffer); fputs("}\n", stdout);
  if (requirement_text) CFRelease(requirement_text);
  if (requirement) CFRelease(requirement);
  if (code) CFRelease(code);
  CFRelease(attributes); CFRelease(data);
  return 0;
}
