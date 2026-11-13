#ifndef KOINCODE_KEYCHAIN_USER_ACCESS_H
#define KOINCODE_KEYCHAIN_USER_ACCESS_H
#include <limits.h>

/* The system runtime owns the OS partition; project code may be freely rebuilt. */
static int wallet_user_exchange(const char *executable, const char *operation,
                                const char *account, const char *service) {
  char path[PATH_MAX];
  if (!realpath(executable, path)) return 74;
  char *slash = strrchr(path, '/');
  const char *resource = "/keychain-user-store.js";
  if (!slash || (size_t)(slash - path) + strlen(resource) >= sizeof(path)) return 74;
  strcpy(slash, resource);
  struct stat info;
  if (lstat(path, &info) || !S_ISREG(info.st_mode) || (info.st_mode & 0022) ||
      (info.st_uid != getuid() && info.st_uid != 0)) return 74;
  execl("/usr/bin/osascript", "osascript", "-l", "JavaScript", path,
        operation, account, service, (char *)NULL);
  return 74;
}
#endif
