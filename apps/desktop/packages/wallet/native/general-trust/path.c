#include "trust.h"
#include <sys/stat.h>
#include <sys/types.h>
#include <fcntl.h>
#include <errno.h>
#include <limits.h>
#include <string.h>
#include <unistd.h>

bool general_fd_protected(int fd, bool directory) {
  struct stat item;
  return fstat(fd, &item) == 0 && item.st_uid == 0 && (item.st_mode & 0022) == 0 &&
    (directory ? S_ISDIR(item.st_mode) : S_ISREG(item.st_mode));
}

bool general_entry_readonly(int parent, const char *name) {
  errno = 0;
  if (faccessat(parent, name, W_OK, AT_EACCESS) == 0) return false;
  return errno == EACCES || errno == EPERM || errno == EROFS;
}

/* Resolve from a protected directory descriptor; never trust a writable parent or symlink. */
int general_protected_open(const char *path, bool directory) {
  if (getuid() == 0 || geteuid() != getuid() || !path || path[0] != '/' || strlen(path) < 2 ||
      strlen(path) >= PATH_MAX || path[strlen(path) - 1] == '/' || strstr(path, "//")) return -1;
  char copy[PATH_MAX];
  memcpy(copy, path + 1, strlen(path));
  int parent = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (parent < 0 || !general_fd_protected(parent, true) || !general_entry_readonly(parent, ".")) {
    if (parent >= 0) close(parent);
    return -1;
  }
  char *save = NULL, *part = strtok_r(copy, "/", &save);
  while (part) {
    char *next = strtok_r(NULL, "/", &save);
    if (strcmp(part, ".") == 0 || strcmp(part, "..") == 0) { close(parent); return -1; }
    const bool want_directory = next != NULL || directory;
    int fd = openat(parent, part, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC | (want_directory ? O_DIRECTORY : 0));
    if (fd < 0 || !general_fd_protected(fd, want_directory) || !general_entry_readonly(parent, part)) {
      if (fd >= 0) close(fd);
      close(parent); return -1;
    }
    close(parent); parent = fd; part = next;
  }
  return parent;
}
