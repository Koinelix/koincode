#include "bundle-resources.h"
#include "session-code.h"
#include "protected-acl.h"
#include "trust.h"
#include <dirent.h>
#include <fcntl.h>
#include <limits.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static atomic_flag occupied = ATOMIC_FLAG_INIT;
static atomic_bool poisoned;
typedef struct { int fd; struct stat identity; bool known; } item;
typedef struct { bool (*current)(void *); void *context; struct timespec started, last; unsigned entries; bool uncertain; } inspection;
static bool active(inspection *op) {
  struct timespec now;
  if (op->uncertain || !op->current(op->context) || clock_gettime(CLOCK_MONOTONIC, &now) || now.tv_nsec < 0 || now.tv_nsec >= 1000000000 ||
      now.tv_sec < op->last.tv_sec || (now.tv_sec == op->last.tv_sec && now.tv_nsec < op->last.tv_nsec)) return false;
  op->last = now; time_t seconds = now.tv_sec - op->started.tv_sec;
  return seconds >= 0 && (seconds < 30 || (seconds == 30 && now.tv_nsec < op->started.tv_nsec));
}
static bool same(const struct stat *left, const struct stat *right) { return left->st_dev == right->st_dev && left->st_ino == right->st_ino && !((left->st_mode ^ right->st_mode) & S_IFMT); }
static bool protected(const struct stat *value, bool directory, bool link) {
  return value->st_uid == 0 && (link ? S_ISLNK(value->st_mode) && value->st_nlink == 1 : !(value->st_mode & 07022) &&
    (directory ? S_ISDIR(value->st_mode) && value->st_nlink > 0 : S_ISREG(value->st_mode) && value->st_nlink == 1 && value->st_size >= 0));
}
static bool descriptor(const item *entry) {
  struct stat value; int flags;
  return entry->known && fstat(entry->fd, &value) == 0 && same(&value, &entry->identity) &&
    protected(&value, S_ISDIR(entry->identity.st_mode), S_ISLNK(entry->identity.st_mode)) &&
    (flags = fcntl(entry->fd, F_GETFD)) >= 0 && (flags & FD_CLOEXEC) && general_protected_acl_readonly(entry->fd);
}
static bool release(inspection *op, item *entry) {
  if (entry->fd < 0) return true;
  struct stat value;
  if (!entry->known || fstat(entry->fd, &value) || !same(&value, &entry->identity)) { op->uncertain = true; return false; }
  int fd = entry->fd; entry->fd = -1;
  if (close(fd)) { op->uncertain = true; return false; }
  return true;
}
static bool capture(inspection *op, item *entry, int fd, bool directory, bool link) {
  entry->fd = fd;
  if (fd < 0) return false;
  if (fstat(fd, &entry->identity)) { op->uncertain = true; return false; }
  entry->known = true; return active(op) && protected(&entry->identity, directory, link) && descriptor(entry);
}
static bool named(const item *parent, const char *name, const item *child) {
  struct stat value;
  return descriptor(parent) && descriptor(child) && fstatat(parent->fd, name, &value, AT_SYMLINK_NOFOLLOW) == 0 && same(&value, &child->identity) &&
    protected(&value, S_ISDIR(child->identity.st_mode), S_ISLNK(child->identity.st_mode));
}
static bool child_open(inspection *op, const item *parent, const char *name, bool directory, bool link, item *out) {
  if (!active(op) || !descriptor(parent)) return false;
  int flags = O_RDONLY | O_NONBLOCK | O_CLOEXEC | (link ? O_SYMLINK : O_NOFOLLOW) | (directory ? O_DIRECTORY : 0);
  return capture(op, out, openat(parent->fd, name, flags), directory, link) && named(parent, name, out) && active(op);
}
static bool fixed_open(inspection *op, const char *path, bool directory, item *out) {
  char copy[PATH_MAX];
  if (!path || path[0] != '/' || strlen(path) < 2 || strlen(path) >= sizeof(copy) || path[strlen(path) - 1] == '/' || strstr(path, "//")) return false;
  memcpy(copy, path + 1, strlen(path));
  item parent = { .fd = -1 };
  bool valid = capture(op, &parent, open("/", O_RDONLY | O_DIRECTORY | O_NONBLOCK | O_CLOEXEC), true, false);
  char *save = NULL, *component = valid ? strtok_r(copy, "/", &save) : NULL;
  while (component) {
    char *next = strtok_r(NULL, "/", &save); item child = { .fd = -1 };
    valid = strcmp(component, ".") && strcmp(component, "..") && child_open(op, &parent, component, next || directory, false, &child);
    if (!release(op, &parent)) valid = false;
    if (!valid) { (void)release(op, &child); return false; }
    parent = child; component = next;
  }
  if (!valid || !active(op)) { (void)release(op, &parent); return false; }
  *out = parent; return true;
}
static bool framework_link(inspection *op, const item *parent, const char *name, const char *path) {
  const char *prefix = GENERAL_TRUST_HOST "/Contents/Frameworks/";
  const char *framework = !strncmp(path, prefix, strlen(prefix)) ? strstr(path + strlen(prefix), ".framework/") : NULL;
  if (!framework) return false;
  size_t boundary = (size_t)(framework - path) + strlen(".framework");
  item link = { .fd = -1 }, target = { .fd = -1 }; char resolved[PATH_MAX]; struct stat value;
  bool valid = child_open(op, parent, name, false, true, &link) && active(op) && realpath(path, resolved) &&
    !strncmp(path, resolved, boundary) && (resolved[boundary] == '/' || !resolved[boundary]) &&
    lstat(resolved, &value) == 0 && (S_ISDIR(value.st_mode) || S_ISREG(value.st_mode)) &&
    fixed_open(op, resolved, S_ISDIR(value.st_mode), &target) && named(parent, name, &link) && active(op);
  if (!release(op, &target)) valid = false;
  if (!release(op, &link)) valid = false;
  return valid;
}
static bool scan(inspection *op, const item *parent, const char *path, unsigned depth) {
  if (depth > 64 || !active(op) || !descriptor(parent)) return false;
  item cursor = { .fd = -1 };
  if (!capture(op, &cursor, fcntl(parent->fd, F_DUPFD_CLOEXEC, 3), true, false)) { (void)release(op, &cursor); return false; }
  DIR *directory = fdopendir(cursor.fd);
  if (!directory) { (void)release(op, &cursor); return false; }
  bool valid = true;
  for (;;) {
    if (!active(op) || !descriptor(parent)) { valid = false; break; }
    errno = 0; struct dirent *entry = readdir(directory); int error = errno;
    if (!entry) { valid = !error; break; }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    if (++op->entries > 30000 || !entry->d_name[0] || strnlen(entry->d_name, NAME_MAX + 1) > NAME_MAX || strchr(entry->d_name, '/')) { valid = false; break; }
    char child_path[PATH_MAX]; int size = snprintf(child_path, sizeof(child_path), "%s/%s", path, entry->d_name); struct stat value;
    if (size < 1 || size >= (int)sizeof(child_path) || fstatat(parent->fd, entry->d_name, &value, AT_SYMLINK_NOFOLLOW)) { valid = false; break; }
    if (S_ISLNK(value.st_mode)) valid = framework_link(op, parent, entry->d_name, child_path);
    else {
      item child = { .fd = -1 };
      valid = (S_ISREG(value.st_mode) || S_ISDIR(value.st_mode)) && child_open(op, parent, entry->d_name, S_ISDIR(value.st_mode), false, &child) &&
        (!S_ISDIR(value.st_mode) || scan(op, &child, child_path, depth + 1)) && named(parent, entry->d_name, &child);
      if (!release(op, &child)) valid = false;
    }
    if (!valid) break;
  }
  struct stat original;
  if (fstat(cursor.fd, &original) || !same(&original, &cursor.identity)) { op->uncertain = true; return false; }
  cursor.fd = -1;
  if (closedir(directory)) { op->uncertain = true; valid = false; }
  return valid && active(op) && descriptor(parent);
}
static bool required(inspection *op, const char *path, bool nonempty) {
  item entry = { .fd = -1 };
  bool valid = fixed_open(op, path, false, &entry) && (!nonempty || entry.identity.st_size > 0) && active(op);
  if (!release(op, &entry)) valid = false;
  return valid;
}
static bool fuses(inspection *op) {
  item entry = { .fd = -1 }; bool valid = false;
  if (fixed_open(op, GENERAL_TRUST_FRAMEWORK, false, &entry) && entry.identity.st_size > 0 && entry.identity.st_size <= 512LL * 1024 * 1024 && active(op)) {
    size_t size = (size_t)entry.identity.st_size;
    void *bytes = mmap(NULL, size, PROT_READ, MAP_PRIVATE, entry.fd, 0);
    if (bytes != MAP_FAILED) {
      valid = active(op) && general_fuses_bytes_valid(bytes, size) && descriptor(&entry) && active(op);
      if (munmap(bytes, size)) { op->uncertain = true; valid = false; }
    }
  }
  if (!release(op, &entry)) valid = false;
  return valid;
}
general_bundle_resource_result general_bundle_resources_check(const general_session_installation *receipt, bool (*current)(void *), void *context) {
  if (atomic_load(&poisoned)) return GENERAL_BUNDLE_RESOURCE_UNCERTAIN;
  if (!receipt || !current) return GENERAL_BUNDLE_RESOURCE_INVALID;
  if (atomic_flag_test_and_set(&occupied)) return GENERAL_BUNDLE_RESOURCE_BUSY;
  inspection op = { .current = current, .context = context }; item host = { .fd = -1 }; bool valid = false;
  if (!clock_gettime(CLOCK_MONOTONIC, &op.started)) {
    op.last = op.started;
    valid = active(&op) && fixed_open(&op, GENERAL_TRUST_HOST, true, &host) && scan(&op, &host, GENERAL_TRUST_HOST, 0) &&
      required(&op, GENERAL_TRUST_EXECUTABLE, true) &&
      required(&op, GENERAL_TRUST_HOST "/Contents/Helpers/GeneralProtectionBroker.app/Contents/MacOS/GeneralProtectionBroker", true) &&
      required(&op, GENERAL_TRUST_HOST "/Contents/Helpers/GeneralProtectionBroker.app/Contents/embedded.provisionprofile", true) &&
      required(&op, GENERAL_TRUST_HOST "/Contents/Helpers/GeneralPaymentOwner.app/Contents/MacOS/GeneralPaymentOwner", true) &&
      required(&op, GENERAL_TRUST_ROOT "/GeneralWalletProvisioner", true) && fuses(&op);
    for (unsigned role = 0; valid && role < 4; role++) valid = active(&op) && general_session_code_distribution(role, receipt) && active(&op);
    if (valid) valid = descriptor(&host) && active(&op);
  }
  if (!release(&op, &host)) valid = false;
  if (op.uncertain) { atomic_store(&poisoned, true); return GENERAL_BUNDLE_RESOURCE_UNCERTAIN; }
  atomic_flag_clear(&occupied); return valid ? GENERAL_BUNDLE_RESOURCE_CHECKED : GENERAL_BUNDLE_RESOURCE_INVALID;
}
