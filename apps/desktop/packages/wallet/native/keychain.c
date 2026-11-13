#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>

#include "keychain-user-access.h"

#include "keychain-legacy-reader.h"

#define MAX_VALUE 1048576
#if defined(KOINCODE_KEYCHAIN_TEST_SERVICE)
#define WALLET_KEYCHAIN_SERVICE KOINCODE_KEYCHAIN_TEST_SERVICE
#elif (defined(KOINCODE_GENERAL_WALLET_NAMESPACE) + defined(KOINCODE_M4_TESTNET_NAMESPACE) + defined(KOINCODE_MAINNET_NAMESPACE)) > 1
#error "General and legacy Keychain namespaces must not be combined."
#elif defined(KOINCODE_MAINNET_NAMESPACE)
#define WALLET_KEYCHAIN_SERVICE "dev.koincode.wallet.mainnet.v1"
#elif defined(KOINCODE_GENERAL_WALLET_NAMESPACE)
#define WALLET_KEYCHAIN_SERVICE "dev.koincode.wallet.general.v1"
#elif defined(KOINCODE_M4_TESTNET_NAMESPACE)
#define WALLET_KEYCHAIN_SERVICE "dev.koincode.wallet.m4-testnet.v1"
#else
#define WALLET_KEYCHAIN_SERVICE "dev.koincode.wallet.testnet.v1"
#endif

static int response_secret_account(const char *account) {
  const char *ref;
  if (strncmp(account, "http-blob:", 10) == 0) ref = account + 10;
  else if (strncmp(account, "http-quarantine:", 16) == 0) ref = account + 16;
  else return 0;
  if (strlen(ref) != 36) return 0;
  for (size_t i = 0; i < 36; i++) {
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (ref[i] != '-') return 0;
    } else if (!((ref[i] >= '0' && ref[i] <= '9') || (ref[i] >= 'a' && ref[i] <= 'f'))) return 0;
  }
  return 1;
}

// File-based macOS Keychain ACL dialogs are separate from SecItem authentication UI.
// This helper is single-purpose and single-threaded; restore its original policy on exit.
static Boolean previous_interaction;
static void restore_interaction(void) {
  (void)SecKeychainSetUserInteractionAllowed(previous_interaction);
}

int main(int argc, char **argv) {
  alarm(10);
  const int legacy_reader = argc == 4 && strcmp(argv[3], "--legacy-reader-v2") == 0;
  const int user_store = argc == 4 && strcmp(argv[3], "--user-store-v2") == 0;
  if ((argc != 3 && !(argc == 4 && (strcmp(argv[3], "--noninteractive") == 0 || user_store || legacy_reader))) || strlen(argv[2]) < 1 || strlen(argv[2]) > (user_store ? 256 : 200)) return 64;
  if (strcmp(argv[1], "remove-response-file") == 0) {
    char account[48];
    if (strlen(argv[2]) != 36) return 64;
    snprintf(account, sizeof(account), "http-blob:%s", argv[2]);
    if (!response_secret_account(account)) return 64;
    struct stat directory;
    if (fstat(3, &directory) != 0 || !S_ISDIR(directory.st_mode) ||
        directory.st_uid != getuid() || (directory.st_mode & 0077) != 0) return 74;
    if (unlinkat(3, argv[2], 0) != 0 && errno != ENOENT) return 74;
    return fsync(3) == 0 ? 0 : 74;
  }
  const int list_legacy = user_store && strcmp(argv[1], "list-legacy") == 0;
  const int remove_response = strcmp(argv[1], "remove-response-secret") == 0;
  if (strcmp(argv[1], "get") != 0 && strcmp(argv[1], "put") != 0 && !remove_response && !list_legacy) return 64;
  if (strspn(argv[2], "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:._-") != strlen(argv[2])) return 64;
  if (user_store && !list_legacy)
    return wallet_user_exchange(argv[0], argv[1], argv[2], WALLET_KEYCHAIN_SERVICE ".user.v2");
  if (legacy_reader && strcmp(argv[1], "get") && strcmp(argv[1], "put")) return 64;
  if (remove_response && !response_secret_account(argv[2])) return 64;
  if (SecKeychainGetUserInteractionAllowed(&previous_interaction) != errSecSuccess) return 74;
  if (atexit(restore_interaction) != 0) return 74;
  if (SecKeychainSetUserInteractionAllowed(false) != errSecSuccess) return 74;
  CFStringRef account = CFStringCreateWithCString(NULL, argv[2], kCFStringEncodingUTF8);
  if (!account) return 64;
  CFMutableDictionaryRef query = CFDictionaryCreateMutable(NULL, 0,
      &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
  CFStringRef service = user_store && !list_legacy ? CFSTR(WALLET_KEYCHAIN_SERVICE ".user.v2") : CFSTR(WALLET_KEYCHAIN_SERVICE);
  CFDictionarySetValue(query, kSecAttrService, service);
  CFDictionarySetValue(query, kSecAttrAccount, account);
  CFDictionarySetValue(query, kSecUseAuthenticationUI, kSecUseAuthenticationUIFail);
  CFRelease(account);
  OSStatus status;
  if (legacy_reader) {
#ifdef KOINCODE_GENERAL_WALLET_NAMESPACE
    CFStringRef anchor = CFSTR("local-v1:general-state-v1");
#else
    CFStringRef anchor = CFSTR("wallet-profile");
#endif
    int result = wallet_legacy_exchange(argv[0], argv[1], argv[2], query, anchor);
    CFRelease(query); return result;
  }
  if (list_legacy) {
    CFDictionaryRemoveValue(query, kSecAttrAccount);
    CFDictionarySetValue(query, kSecReturnAttributes, kCFBooleanTrue);
    CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitAll);
    CFTypeRef rows = NULL; status = SecItemCopyMatching(query, &rows);
    if (status == errSecItemNotFound) { fputs("[]", stdout); status = errSecSuccess; }
    else if (!status && rows && CFGetTypeID(rows) == CFArrayGetTypeID() && CFArrayGetCount(rows) <= 4096) {
      CFIndex count = CFArrayGetCount(rows);
      char names[4096][201];
      for (CFIndex i = 0; i < count; i++) {
        CFTypeRef row = CFArrayGetValueAtIndex(rows, i);
        CFTypeRef name = CFGetTypeID(row) == CFDictionaryGetTypeID() ? CFDictionaryGetValue(row, kSecAttrAccount) : NULL;
        if (!name || CFGetTypeID(name) != CFStringGetTypeID() || !CFStringGetCString(name, names[i], sizeof(names[i]), kCFStringEncodingUTF8) ||
            strspn(names[i], "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:._-") != strlen(names[i])) { status = errSecDecode; break; }
      }
      if (!status) { fputc('[', stdout); for (CFIndex i=0;i<count;i++) fprintf(stdout, "%s\"%s\"", i ? "," : "", names[i]); fputc(']', stdout); }
    } else if (!status) status = errSecDecode;
    if (rows) CFRelease(rows);
    CFRelease(query);
    return status == errSecSuccess ? 0 : 74;
  }
  if (remove_response) {
    status = SecItemDelete(query);
    if (status == errSecItemNotFound) status = errSecSuccess;
  } else if (strcmp(argv[1], "get") == 0) {
    CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue);
    CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);
    CFTypeRef result = NULL;
    status = SecItemCopyMatching(query, &result);
    if (status == errSecSuccess && result && CFGetTypeID(result) == CFDataGetTypeID()) {
      CFDataRef data = (CFDataRef)result;
      CFIndex length = CFDataGetLength(data);
      if (length < 0 || length > MAX_VALUE || fwrite(CFDataGetBytePtr(data), 1, (size_t)length, stdout) != (size_t)length) status = errSecIO;
    } else if (status == errSecSuccess) status = errSecDecode;
    if (result) CFRelease(result);
  } else {
    unsigned char *bytes = malloc(MAX_VALUE + 1);
    if (!bytes) { CFRelease(query); return 74; }
    size_t length = fread(bytes, 1, MAX_VALUE + 1, stdin);
    if (ferror(stdin) || length == 0 || length > MAX_VALUE) {
      memset(bytes, 0, MAX_VALUE + 1); free(bytes); CFRelease(query); return 64;
    }
    CFDataRef data = CFDataCreate(NULL, bytes, (CFIndex)length);
    memset(bytes, 0, MAX_VALUE + 1); free(bytes);
    if (!data) { CFRelease(query); return 74; }
    CFMutableDictionaryRef update = CFDictionaryCreateMutable(NULL, 0,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFDictionarySetValue(update, kSecValueData, data);
    status = SecItemUpdate(query, update);
    if (status == errSecItemNotFound) {
      CFDictionarySetValue(query, kSecValueData, data);
      CFDictionarySetValue(query, kSecAttrAccessible, kSecAttrAccessibleWhenUnlockedThisDeviceOnly);
      status = SecItemAdd(query, NULL);
    }
    CFRelease(update); CFRelease(data);
  }
  CFRelease(query);
  if (status == errSecSuccess) return 0;
  if (status == errSecItemNotFound) return 44;
  if (status == errSecInteractionNotAllowed || status == errSecInteractionRequired || status == errSecAuthFailed) return 77;
  fputs("System-protected storage is unavailable.\n", stderr);
  return 74;
}
