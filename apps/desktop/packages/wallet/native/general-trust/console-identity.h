#ifndef KOINCODE_GENERAL_CONSOLE_IDENTITY_H
#define KOINCODE_GENERAL_CONSOLE_IDENTITY_H
#include <stdbool.h>
#include <stdint.h>
#include <limits.h>

typedef struct { uint32_t uid, gid; char account[256], home[PATH_MAX]; } general_console_identity;
/* OS metadata only. Never authentication, peer, namespace/fresh or Keychain
 * authority. No environment or caller-selected identity is consulted. Output
 * is private to the original actor and unchanged on failure. */
bool general_console_identity_read(bool (*current)(void *), void *context, general_console_identity *out);
bool general_console_identity_matches(const general_console_identity *expected, bool (*current)(void *), void *context);
#endif
