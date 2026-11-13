#include "resource-repository-verify.h"
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/acl.h>
#include <time.h>
#include <unistd.h>

#define PHYSICAL_LIMIT (UINT64_C(512) * 1024 * 1024)
typedef struct { bool (*current)(void *); void *context; struct timespec start, last; } operation;
static bool active(operation *op) {
  struct timespec now;
  if (!op->current(op->context) || clock_gettime(CLOCK_MONOTONIC, &now) || now.tv_sec < 0 || now.tv_nsec < 0 || now.tv_nsec >= 1000000000 ||
      now.tv_sec < op->last.tv_sec || (now.tv_sec == op->last.tv_sec && now.tv_nsec < op->last.tv_nsec)) return false;
  op->last = now;
  return now.tv_sec - op->start.tv_sec < 30 || (now.tv_sec - op->start.tv_sec == 30 && now.tv_nsec < op->start.tv_nsec);
}
static bool same(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_size == b->st_size;
}
static bool no_acl(int fd) {
  errno = 0; acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED); if (!acl) return errno == ENOENT;
  acl_entry_t entry; errno = 0; int found = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry), error = errno;
  return acl_free(acl) == 0 && found == -1 && error == EINVAL;
}
static bool private_entry(const struct stat *entry, bool directory, uid_t uid) {
  return entry->st_uid == uid && (entry->st_mode & 07777) == (directory ? 0700 : 0600) &&
    (directory ? S_ISDIR(entry->st_mode) && entry->st_nlink >= 1 : S_ISREG(entry->st_mode) && entry->st_nlink == 1 && entry->st_size >= 0);
}
static bool held(int fd, bool directory, uid_t uid, struct stat *out) {
  int flags;
  return fd >= 0 && !fstat(fd, out) && private_entry(out, directory, uid) &&
    (flags = fcntl(fd, F_GETFD)) >= 0 && (flags & FD_CLOEXEC) &&
    (flags = fcntl(fd, F_GETFL)) >= 0 && !(flags & O_APPEND) && (directory || (flags & O_ACCMODE) == O_RDWR) && no_acl(fd);
}
static bool named(int directory, const char *name, const struct stat *actual, uid_t uid) {
  struct stat value;
  return !fstatat(directory, name, &value, AT_SYMLINK_NOFOLLOW) && private_entry(&value, false, uid) && same(actual, &value);
}
static bool sidecars(int directory, const char *database, uid_t uid, uint64_t budget) {
  char name[96]; struct stat value;
  const char *suffixes[] = { "-journal", "-shm" };
  for (unsigned i = 0; i < 2; i++) {
    int size = snprintf(name, sizeof(name), "%s%s", database, suffixes[i]);
    if (size < 1 || size >= (int)sizeof(name) || !fstatat(directory, name, &value, AT_SYMLINK_NOFOLLOW) || errno != ENOENT) return false;
  }
  const char *lease[] = { "writer-lease.sqlite-journal", "writer-lease.sqlite-shm", "writer-lease.sqlite-wal" };
  for (unsigned i = 0; i < 3; i++) if (!fstatat(directory, lease[i], &value, AT_SYMLINK_NOFOLLOW) || errno != ENOENT) return false;
  int size = snprintf(name, sizeof(name), "%s-wal", database);
  return size > 0 && size < (int)sizeof(name) && !fstatat(directory, name, &value, AT_SYMLINK_NOFOLLOW) &&
    private_entry(&value, false, uid) && (uint64_t)value.st_size <= PHYSICAL_LIMIT - budget;
}
static bool locked(int fd, pid_t host) {
  struct flock lock = { .l_type = F_WRLCK, .l_whence = SEEK_SET, .l_start = 0x40000002, .l_len = 510 };
  return !fcntl(fd, F_GETLK, &lock) && lock.l_type == F_WRLCK && lock.l_whence == SEEK_SET && lock.l_pid == host &&
    lock.l_start <= 0x40000002 && (lock.l_len == 0 || (lock.l_len >= 510 && lock.l_start >= 0 && lock.l_start <= INT64_MAX - lock.l_len &&
      lock.l_start + lock.l_len >= 0x40000002 + 510));
}
bool general_resource_repository_verify(int directory, int database, int writer_lease, general_resource_kind kind,
    general_channel_peer *host, bool (*current)(void *), void *context, general_resource_repository_identity *out) {
  if (!current || !out || !getuid() || geteuid() != getuid() || directory < 0 || database < 0 || writer_lease < 0 ||
      directory == database || directory == writer_lease || database == writer_lease ||
      (kind != GENERAL_RESOURCE_STATE_REPOSITORY && kind != GENERAL_RESOURCE_SIGNING_REPOSITORY)) return false;
  operation op = { .current = current, .context = context };
  if (clock_gettime(CLOCK_MONOTONIC, &op.start) || op.start.tv_sec < 0 || op.start.tv_nsec < 0 || op.start.tv_nsec >= 1000000000) return false;
  op.last = op.start; audit_token_t token, after;
  if (!active(&op) || !general_channel_peer_role_current(host, GENERAL_CHANNEL_BROKER_HOST) || !active(&op) || !general_channel_peer_token(host, &token) ||
      audit_token_to_euid(token) != geteuid() || audit_token_to_ruid(token) != getuid() || audit_token_to_pid(token) <= 0 || audit_token_to_pid(token) == getpid()) return false;
  const char *name = kind == GENERAL_RESOURCE_STATE_REPOSITORY ? "general-wallet.sqlite" : "general-signing-journal.sqlite";
  struct stat original[3], verified[3]; int fds[] = { directory, database, writer_lease };
  for (unsigned i = 0; i < 3; i++) if (!active(&op) || !held(fds[i], i == 0, geteuid(), &original[i])) return false;
  if ((original[1].st_dev == original[2].st_dev && original[1].st_ino == original[2].st_ino) || !original[1].st_size || !original[2].st_size ||
      (uint64_t)original[1].st_size > PHYSICAL_LIMIT || (uint64_t)original[2].st_size > PHYSICAL_LIMIT - (uint64_t)original[1].st_size) return false;
  uint64_t budget = (uint64_t)original[1].st_size + (uint64_t)original[2].st_size;
  if (!active(&op) || !named(directory, name, &original[1], geteuid()) || !named(directory, "writer-lease.sqlite", &original[2], geteuid()) ||
      !sidecars(directory, name, geteuid(), budget) || !locked(writer_lease, audit_token_to_pid(token)) || !active(&op) ||
      !general_channel_peer_role_current(host, GENERAL_CHANNEL_BROKER_HOST) || !general_channel_peer_token(host, &after) || memcmp(&token, &after, sizeof(token)) || !active(&op)) return false;
  for (unsigned i = 0; i < 3; i++) if (!held(fds[i], i == 0, geteuid(), &verified[i]) || !same(&original[i], &verified[i])) return false;
  if (!named(directory, name, &verified[1], geteuid()) || !named(directory, "writer-lease.sqlite", &verified[2], geteuid()) ||
      !sidecars(directory, name, geteuid(), budget) || !locked(writer_lease, audit_token_to_pid(token)) || !active(&op)) return false;
  general_resource_repository_identity result;
  if (!general_resource_identity_from_stat(&verified[0], &result.directory) || !general_resource_identity_from_stat(&verified[1], &result.database) ||
      !general_resource_identity_from_stat(&verified[2], &result.writer_lease)) return false;
  *out = result; return true;
}
