#include <Security/Security.h>
#include <unistd.h>

/* One-time legacy compatibility reader only, never the active storage backend. */
__attribute__((constructor)) static void disable_legacy_interaction(void) {
  if (SecKeychainSetUserInteractionAllowed(false) != errSecSuccess) _exit(77);
}
