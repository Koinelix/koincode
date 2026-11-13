#include "enrollment-listener.h"
#include "protected-acl.h"
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

struct general_enrollment_listener {
  int directory, socket; struct stat directory_id, socket_id, entry_id;
  char directory_path[PATH_MAX], path[sizeof(((struct sockaddr_un *)0)->sun_path)];
  uint32_t uid, gid; bool directory_known, socket_known, bound, entry_known, locked, ready, poisoned;
  bool (*current)(void *); void *context;
};
static bool root(void) { return getuid() == 0 && geteuid() == 0; }
static bool same(const struct stat *left, const struct stat *right) { return left->st_dev == right->st_dev && left->st_ino == right->st_ino && !((left->st_mode ^ right->st_mode) & S_IFMT); }
static bool flags(int fd) {
  int value = fcntl(fd, F_GETFD), status = fcntl(fd, F_GETFL);
  return value >= 0 && (value & FD_CLOEXEC) && status >= 0 && (status & O_NONBLOCK);
}
static bool directory_current(general_enrollment_listener *owner) {
  struct stat value; char path[PATH_MAX]; int fd_flags = fcntl(owner->directory, F_GETFD);
  struct flock lock = { .l_type = F_WRLCK, .l_whence = SEEK_SET, .l_start = 0, .l_len = 0, .l_pid = -1 };
  return owner->directory_known && fd_flags >= 0 && (fd_flags & FD_CLOEXEC) && fstat(owner->directory, &value) == 0 && same(&value, &owner->directory_id) && S_ISDIR(value.st_mode) &&
    value.st_uid == 0 && !(value.st_mode & 07022) && general_protected_acl_readonly(owner->directory) &&
    fcntl(owner->directory, F_GETPATH, path) == 0 && !strcmp(path, owner->directory_path) &&
    (!owner->locked || (fcntl(owner->directory, F_OFD_GETLK, &lock) == 0 && lock.l_type == F_WRLCK && lock.l_pid == -1 && lock.l_whence == SEEK_SET && !lock.l_start && !lock.l_len));
}
static bool entry_current(general_enrollment_listener *owner, bool permissions) {
  struct stat value;
  if (!owner->entry_known || fstatat(owner->directory, "enrollment.sock", &value, AT_SYMLINK_NOFOLLOW) || !same(&value, &owner->entry_id) || !S_ISSOCK(value.st_mode) || value.st_nlink != 1) return false;
  if (!permissions) return true;
  if (value.st_uid != owner->uid || value.st_gid != owner->gid || (value.st_mode & 07777) != 0600) return false;
  errno = 0;
  return general_protected_acl_consume_readonly(acl_get_link_np(owner->path, ACL_TYPE_EXTENDED)) &&
    fstatat(owner->directory, "enrollment.sock", &value, AT_SYMLINK_NOFOLLOW) == 0 && same(&value, &owner->entry_id) &&
    value.st_uid == owner->uid && value.st_gid == owner->gid && (value.st_mode & 07777) == 0600;
}
bool general_enrollment_listener_current(general_enrollment_listener *owner) {
  struct stat value;
  return owner && owner->ready && !owner->poisoned && root() && owner->current(owner->context) && directory_current(owner) &&
    owner->socket_known && fstat(owner->socket, &value) == 0 && same(&value, &owner->socket_id) && S_ISSOCK(value.st_mode) && flags(owner->socket) && entry_current(owner, true);
}
general_listener_result general_enrollment_listener_open(int directory, uint32_t uid, uint32_t gid,
  bool (*current)(void *), void *context, general_enrollment_listener **out) {
  if (!root() || directory < 0 || !uid || uid == UINT32_MAX || gid == UINT32_MAX || !current || !out || *out) return GENERAL_LISTENER_UNAVAILABLE;
  general_enrollment_listener *owner = calloc(1, sizeof(*owner)); if (!owner) return GENERAL_LISTENER_UNAVAILABLE;
  owner->directory = owner->socket = -1; owner->uid = uid; owner->gid = gid; owner->current = current; owner->context = context;
  general_listener_result result = GENERAL_LISTENER_UNAVAILABLE;
  int size = snprintf(owner->directory_path, sizeof(owner->directory_path), "/Library/KoinCodeProtectedWallet/users/%u", uid);
  if (size < 1 || size >= (int)sizeof(owner->directory_path) || !current(context)) goto fail;
  owner->directory = fcntl(directory, F_DUPFD_CLOEXEC, 3);
  if (owner->directory < 0) goto fail;
  if (fstat(owner->directory, &owner->directory_id)) { owner->poisoned = true; goto fail; }
  owner->directory_known = true;
  if (!directory_current(owner) || !current(context)) goto fail;
  if (flock(owner->directory, LOCK_EX | LOCK_NB)) { if (errno == EAGAIN || errno == EWOULDBLOCK) result = GENERAL_LISTENER_BUSY; goto fail; }
  owner->locked = true;
  struct stat existing;
  if (fstatat(owner->directory, "enrollment.sock", &existing, AT_SYMLINK_NOFOLLOW) == 0) { result = GENERAL_LISTENER_CONFLICT; goto fail; }
  if (errno != ENOENT || !directory_current(owner) || !current(context)) goto fail;
  size = snprintf(owner->path, sizeof(owner->path), "%s/enrollment.sock", owner->directory_path);
  if (size < 1 || size >= (int)sizeof(owner->path)) goto fail;
  owner->socket = socket(AF_UNIX, SOCK_STREAM, 0);
  if (owner->socket < 0) goto fail;
  if (fstat(owner->socket, &owner->socket_id)) { owner->poisoned = true; goto fail; }
  owner->socket_known = true;
  int fd_flags = fcntl(owner->socket, F_GETFD), status = fcntl(owner->socket, F_GETFL);
  if (fd_flags < 0 || status < 0 || fcntl(owner->socket, F_SETFD, fd_flags | FD_CLOEXEC) || fcntl(owner->socket, F_SETFL, status | O_NONBLOCK) || !current(context)) goto fail;
  struct sockaddr_un address = { .sun_family = AF_UNIX }; strcpy(address.sun_path, owner->path);
  if (bind(owner->socket, (struct sockaddr *)&address, sizeof(address))) { if (errno == EADDRINUSE) result = GENERAL_LISTENER_CONFLICT; else owner->poisoned = true; goto fail; }
  owner->bound = true;
  if (fstatat(owner->directory, "enrollment.sock", &owner->entry_id, AT_SYMLINK_NOFOLLOW)) { owner->poisoned = true; goto fail; }
  owner->entry_known = true;
  if (!entry_current(owner, false) || !directory_current(owner) || !current(context) ||
      fchownat(owner->directory, "enrollment.sock", uid, gid, AT_SYMLINK_NOFOLLOW) || !entry_current(owner, false) ||
      fchmodat(owner->directory, "enrollment.sock", 0600, 0) || !entry_current(owner, true) || !current(context) || listen(owner->socket, 1)) goto fail;
  owner->ready = true;
  if (!general_enrollment_listener_current(owner)) goto fail;
  *out = owner; return GENERAL_LISTENER_READY;
fail:
  owner->ready = false;
  if (!general_enrollment_listener_close(&owner)) { *out = owner; return GENERAL_LISTENER_UNCERTAIN; }
  return result;
}
int general_enrollment_listener_accept(general_enrollment_listener *owner, int *out) {
  if (!out || *out >= 0 || !general_enrollment_listener_current(owner)) return -1;
  struct pollfd ready = { .fd = owner->socket, .events = POLLIN | POLLHUP };
  int observed = poll(&ready, 1, 50); int error = errno;
  if (!general_enrollment_listener_current(owner) || (observed < 0 && error != EINTR) || (ready.revents & (POLLERR | POLLHUP | POLLNVAL))) return -1;
  if (observed <= 0 || !(ready.revents & POLLIN)) return 0;
  int fd = accept(owner->socket, NULL, NULL);
  if (fd < 0) return errno == EAGAIN || errno == EWOULDBLOCK ? 0 : -1;
  int flags = fcntl(fd, F_GETFD), status = fcntl(fd, F_GETFL);
  if (flags < 0 || status < 0 || fcntl(fd, F_SETFD, flags | FD_CLOEXEC) || fcntl(fd, F_SETFL, status | O_NONBLOCK) || !general_enrollment_listener_current(owner)) {
    if (close(fd)) owner->poisoned = true;
    return -1;
  }
  *out = fd; return 1;
}
bool general_enrollment_listener_close(general_enrollment_listener **pointer) {
  if (!pointer || !*pointer) return true;
  general_enrollment_listener *owner = *pointer;
  if (owner->poisoned) return false;
  owner->ready = false;
  if (owner->socket >= 0) {
    struct stat value;
    if (!owner->socket_known || fstat(owner->socket, &value) || !same(&value, &owner->socket_id)) { owner->poisoned = true; return false; }
    int fd = owner->socket; owner->socket = -1;
    if (close(fd)) { owner->poisoned = true; return false; }
  }
  if (owner->bound) {
    if (!directory_current(owner) || !entry_current(owner, false) || unlinkat(owner->directory, "enrollment.sock", 0)) { owner->poisoned = true; return false; }
    owner->bound = false;
  }
  if (owner->directory >= 0) {
    struct stat value;
    if (!owner->directory_known || fstat(owner->directory, &value) || !same(&value, &owner->directory_id)) { owner->poisoned = true; return false; }
    int fd = owner->directory; owner->directory = -1;
    if (close(fd)) { owner->poisoned = true; return false; }
  }
  free(owner); *pointer = NULL; return true;
}
