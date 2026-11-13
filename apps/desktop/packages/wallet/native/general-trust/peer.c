#include "trust.h"
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

bool general_socket_peer(int fd, audit_token_t *token, SecCodeRef *code) {
  if (!token || !code || getuid() == 0 || geteuid() != getuid()) return false;
  *code = NULL;
  int socket_type = 0; socklen_t type_size = sizeof(socket_type);
  if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &socket_type, &type_size) != 0 || socket_type != SOCK_STREAM) return false;
  socklen_t size = sizeof(*token);
  uid_t uid; gid_t gid;
  if (getpeereid(fd, &uid, &gid) != 0 || uid != getuid() ||
      getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, token, &size) != 0 || size != sizeof(*token) ||
      audit_token_to_euid(*token) != uid || audit_token_to_pid(*token) <= 0) return false;
  CFDataRef data = CFDataCreate(NULL, (const UInt8 *)token, sizeof(*token));
  if (!data) return false;
  const void *keys[] = { kSecGuestAttributeAudit }, *values[] = { data };
  CFDictionaryRef attributes = CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  if (!attributes) { CFRelease(data); return false; }
  OSStatus result = SecCodeCopyGuestWithAttributes(NULL, attributes, kSecCSDefaultFlags, code);
  CFRelease(attributes); CFRelease(data);
  if (result != errSecSuccess || !*code) { if (*code) CFRelease(*code); *code = NULL; return false; }
  if (SecCodeCheckValidity(*code, kSecCSStrictValidate, NULL) != errSecSuccess) { CFRelease(*code); *code = NULL; return false; }
  return true;
}
