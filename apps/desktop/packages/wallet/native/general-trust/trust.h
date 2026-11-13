#ifndef KOINCODE_GENERAL_TRUST_H
#define KOINCODE_GENERAL_TRUST_H
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <bsm/libbsm.h>
#include <stdbool.h>
#include <stddef.h>

#define GENERAL_TRUST_ROOT "/Library/KoinCodeProtectedWallet"
#define GENERAL_TRUST_RECEIPT GENERAL_TRUST_ROOT "/installation.plist"
#define GENERAL_TRUST_HOST GENERAL_TRUST_ROOT "/WalletHost.app"
#define GENERAL_TRUST_EXECUTABLE GENERAL_TRUST_HOST "/Contents/MacOS/WalletHost"
#define GENERAL_TRUST_FRAMEWORK GENERAL_TRUST_HOST "/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework"
#define GENERAL_TRUST_BROKER GENERAL_TRUST_HOST "/Contents/Helpers/GeneralProtectionBroker"
#define GENERAL_TRUST_HOST_ID "dev.koincode.wallet.host"
#define GENERAL_TRUST_BROKER_ID "dev.koincode.wallet.protection"
#define GENERAL_TRUST_MAX_RECEIPT 16384

typedef struct {
  char installation_id[37];
  int64_t revision;
  unsigned char host_hash[20];
  unsigned char broker_hash[20];
} general_trust_receipt;

typedef enum { GENERAL_IDENTITY_INSTALLATION_UNVERIFIED, GENERAL_IDENTITY_CODE_UNVERIFIED, GENERAL_IDENTITY_VERIFIED } general_identity_status;
general_identity_status general_check_identity(int fd);
int general_preflight_reply(int fd);

bool general_entry_readonly(int parent, const char *name);
bool general_fd_protected(int fd, bool directory);
bool general_bundle_tree_protected(void);
int general_protected_open(const char *path, bool directory);
bool general_parse_receipt(const unsigned char *bytes, size_t size, general_trust_receipt *receipt);
bool general_read_receipt(general_trust_receipt *receipt);
bool general_socket_peer(int fd, audit_token_t *token, SecCodeRef *code);
bool general_matches_code(SecStaticCodeRef code, const char *path, const char *identifier,
  const unsigned char hash[20], bool dynamic);
bool general_bundle_is_valid(void);
bool general_fuses_bytes_valid(const unsigned char *bytes, size_t size);
bool general_host_fuses_valid(void);
bool general_launch_arguments_valid(const unsigned char *bytes, size_t size, const char *executable);
bool general_peer_launch_valid(int fd, const audit_token_t *token);
#endif
