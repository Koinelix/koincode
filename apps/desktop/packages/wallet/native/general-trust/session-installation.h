#ifndef KOINCODE_GENERAL_SESSION_INSTALLATION_H
#define KOINCODE_GENERAL_SESSION_INSTALLATION_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define GENERAL_SESSION_RECEIPT_MAX 16384U
#define GENERAL_SESSION_ACCESS_GROUP_SUFFIX ".dev.koincode.wallet.general.protected"
typedef struct {
  char installation_id[37];
  int64_t revision;
  unsigned char host_hash[20];
  unsigned char broker_hash[20];
  char team_id[11];
  char keychain_access_group[10 + sizeof(GENERAL_SESSION_ACCESS_GROUP_SUFFIX)];
} general_session_installation;

/* Parsing is not trust verification. Caller output is unchanged on rejection. */
bool general_parse_session_installation(const unsigned char *bytes, size_t size, general_session_installation *output);
#endif
