#include "trust.h"
#include <sys/socket.h>
#include <string.h>

/* Read-only identity preflight. It intentionally cannot authorize secret admission. */
int general_preflight_reply(int fd) {
  int type = 0; socklen_t size = sizeof(type);
  if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &size) != 0 || type != SOCK_STREAM) return 74;
  general_identity_status status = general_check_identity(fd);
  const char *yes = "{\"version\":1,\"identityStatus\":\"verified\",\"secretAdmission\":\"unverified\",\"code\":\"GENERAL_SECRET_ADMISSION_UNVERIFIED\"}\n";
  const char *missing = "{\"version\":1,\"identityStatus\":\"unverified\",\"secretAdmission\":\"unverified\",\"code\":\"GENERAL_INSTALLATION_UNVERIFIED\"}\n";
  const char *invalid = "{\"version\":1,\"identityStatus\":\"unverified\",\"secretAdmission\":\"unverified\",\"code\":\"GENERAL_NATIVE_IDENTITY_UNVERIFIED\"}\n";
  const char *result = status == GENERAL_IDENTITY_VERIFIED ? yes : status == GENERAL_IDENTITY_INSTALLATION_UNVERIFIED ? missing : invalid;
  size_t used = 0, length = strlen(result);
  while (used < length) {
    ssize_t count = send(fd, result + used, length - used, MSG_NOSIGNAL);
    if (count <= 0) return 74;
    used += (size_t)count;
  }
  return 0;
}
