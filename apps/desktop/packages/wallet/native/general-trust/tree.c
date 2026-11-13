#include "trust.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define MAX_ENTRIES 30000
#define MAX_DEPTH 64

/* Framework symlinks are allowed only when their canonical target stays inside the protected bundle. */
static bool protected_link(int parent, const char *name, const char *path) {
  struct stat link;
  if (fstatat(parent, name, &link, AT_SYMLINK_NOFOLLOW) != 0 || link.st_uid != 0 || !S_ISLNK(link.st_mode)) return false;
  char target[PATH_MAX];
  if (!realpath(path, target)) return false;
  size_t size = strlen(GENERAL_TRUST_HOST);
  if (strncmp(target, GENERAL_TRUST_HOST, size) != 0 || (target[size] != '/' && target[size] != '\0')) return false;
  struct stat info;
  if (stat(target, &info) != 0 || (!S_ISDIR(info.st_mode) && !S_ISREG(info.st_mode))) return false;
  int fd = general_protected_open(target, S_ISDIR(info.st_mode));
  if (fd < 0) return false;
  close(fd); return true;
}

static bool scan(int fd, const char *path, unsigned depth, unsigned *count) {
  if (depth > MAX_DEPTH) return false;
  int duplicate = dup(fd);
  if (duplicate < 0) return false;
  DIR *dir = fdopendir(duplicate);
  if (!dir) { close(duplicate); return false; }
  bool ok = true;
  struct dirent *entry;
  for (;;) {
    errno = 0;
    entry = readdir(dir);
    if (!entry) { if (errno != 0) ok = false; break; }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (++*count > MAX_ENTRIES) { ok = false; break; }
    struct stat info;
    char child_path[PATH_MAX];
    int size = snprintf(child_path, sizeof(child_path), "%s/%s", path, entry->d_name);
    if (size < 0 || (size_t)size >= sizeof(child_path) || fstatat(fd, entry->d_name, &info, AT_SYMLINK_NOFOLLOW) != 0) { ok = false; break; }
    if (S_ISLNK(info.st_mode)) {
      if (!protected_link(fd, entry->d_name, child_path)) { ok = false; break; }
    } else {
      if (!S_ISDIR(info.st_mode) && !S_ISREG(info.st_mode)) { ok = false; break; }
      int child = openat(fd, entry->d_name, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC | (S_ISDIR(info.st_mode) ? O_DIRECTORY : 0));
      if (child < 0) { ok = false; break; }
      ok = general_fd_protected(child, S_ISDIR(info.st_mode)) && general_entry_readonly(fd, entry->d_name);
      if (ok && S_ISDIR(info.st_mode)) ok = scan(child, child_path, depth + 1, count);
      close(child);
      if (!ok) break;
    }
  }
  closedir(dir); return ok;
}

bool general_bundle_tree_protected(void) {
  int fd = general_protected_open(GENERAL_TRUST_HOST, true);
  if (fd < 0) return false;
  unsigned count = 0;
  bool ok = scan(fd, GENERAL_TRUST_HOST, 0, &count);
  close(fd); return ok;
}
