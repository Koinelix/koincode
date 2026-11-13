#include "native-directory.h"
#include "console-identity.h"
#include "protected-acl.h"
#include <fcntl.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define MAX_NODES 64U
static atomic_flag occupied = ATOMIC_FLAG_INIT;
struct general_native_directory {
  int nodes[MAX_NODES]; struct stat ids[MAX_NODES];
  char names[MAX_NODES][NAME_MAX + 1], paths[MAX_NODES][PATH_MAX];
  unsigned count, private_start, home_index;
  bool known[MAX_NODES], ready, loan, running, poisoned, enrollment_loan, transfer_attempted;
  general_console_identity console;
  general_native_identity identity;
  bool (*current)(void *); void *context;
};
typedef struct { general_native_directory *owner; struct timespec started, last; } operation;
static bool same(const struct stat *a, const struct stat *b) { return a->st_dev == b->st_dev && a->st_ino == b->st_ino; }
static bool permissions(general_native_directory *owner, unsigned index, const struct stat *value) {
  if (!S_ISDIR(value->st_mode) || value->st_nlink < 1 || (value->st_mode & 07000)) return false;
  if (index >= owner->private_start) return value->st_uid == owner->console.uid && (value->st_mode & 0777) == 0700;
  return !(value->st_mode & 0022) && (index >= owner->home_index ? value->st_uid == owner->console.uid :
    value->st_uid == 0 || value->st_uid == owner->console.uid);
}
static bool private_acl(int fd) {
  errno = 0; acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (!acl) return errno == ENOENT;
  bool valid = false; acl_entry_t entry;
  for (unsigned i = 0; i <= ACL_MAX_ENTRIES; i++) {
    errno = 0; int result = acl_get_entry(acl, i ? ACL_NEXT_ENTRY : ACL_FIRST_ENTRY, &entry);
    if (result == -1) { valid = errno == EINVAL; break; }
    acl_tag_t tag;
    if (result || i == ACL_MAX_ENTRIES || acl_get_tag_type(entry, &tag) || tag != ACL_EXTENDED_DENY) break;
  }
  acl_free(acl); return valid;
}
static bool node_current(general_native_directory *owner, unsigned index) {
  struct stat actual, named; char path[PATH_MAX]; int flags;
  return owner->known[index] && !fstat(owner->nodes[index], &actual) && same(&actual, &owner->ids[index]) && permissions(owner, index, &actual) &&
    (flags = fcntl(owner->nodes[index], F_GETFD)) >= 0 && (flags & FD_CLOEXEC) &&
    (index >= owner->private_start ? private_acl(owner->nodes[index]) : general_protected_acl_readonly(owner->nodes[index])) &&
    !fcntl(owner->nodes[index], F_GETPATH, path) && !strcmp(path, owner->paths[index]) &&
    (!index || (!fstatat(owner->nodes[index - 1], owner->names[index], &named, AT_SYMLINK_NOFOLLOW) && same(&actual, &named) && permissions(owner, index, &named)));
}
static bool active(void *context) {
  operation *op = context; general_native_directory *owner = op->owner; struct timespec now;
  if (owner->poisoned || !owner->current(owner->context) || getuid() != owner->console.uid || geteuid() != owner->console.uid) return false;
  for (unsigned i = 0; i < owner->count; i++) if (owner->known[i] && !node_current(owner, i)) return false;
  if (clock_gettime(CLOCK_MONOTONIC, &now) || now.tv_nsec < 0 || now.tv_nsec >= 1000000000 || now.tv_sec < op->last.tv_sec ||
      (now.tv_sec == op->last.tv_sec && now.tv_nsec < op->last.tv_nsec) || now.tv_sec < op->started.tv_sec ||
      now.tv_sec - op->started.tv_sec > 30 || (now.tv_sec - op->started.tv_sec == 30 && now.tv_nsec >= op->started.tv_nsec)) return false;
  op->last = now; return true;
}
static bool begin(general_native_directory *owner, operation *op) {
  *op = (operation){ .owner = owner };
  if (clock_gettime(CLOCK_MONOTONIC, &op->started)) return false;
  op->last = op->started; return active(op);
}
static bool snapshot(operation *op) { return active(op) && general_console_identity_matches(&op->owner->console, active, op) && active(op); }
static bool add(general_native_directory *owner, const char *name) {
  size_t size = strlen(name); unsigned index = owner->count;
  if (index >= MAX_NODES || !size || size > NAME_MAX || strchr(name, '/') || !strcmp(name, ".") || !strcmp(name, "..")) return false;
  memcpy(owner->names[index], name, size + 1);
  int length = snprintf(owner->paths[index], PATH_MAX, "%s%s%s", owner->paths[index - 1], index > 1 ? "/" : "", name);
  if (length < 1 || length >= PATH_MAX) return false;
  owner->count++; return true;
}
general_native_directory_result general_native_directory_open(const general_native_identity *identity, bool create,
    bool (*current)(void *), void *context, general_native_directory **out) {
  if (!identity || !general_native_identity_valid(identity) || !current || !out || *out || !getuid() || geteuid() != getuid()) return GENERAL_NATIVE_DIRECTORY_REJECTED;
  const general_native_identity frozen_identity = *identity; identity = &frozen_identity;
  if (atomic_flag_test_and_set(&occupied)) return GENERAL_NATIVE_DIRECTORY_BUSY;
  general_native_directory *owner = calloc(1, sizeof(*owner));
  if (!owner) { atomic_flag_clear(&occupied); return GENERAL_NATIVE_DIRECTORY_REJECTED; }
  for (unsigned i = 0; i < MAX_NODES; i++) owner->nodes[i] = -1;
  owner->identity = *identity; owner->current = current; owner->context = context; owner->private_start = owner->home_index = MAX_NODES;
  general_native_directory_result result = GENERAL_NATIVE_DIRECTORY_REJECTED; operation op;
  if (clock_gettime(CLOCK_MONOTONIC, &op.started)) goto fail;
  op.owner = owner; op.last = op.started;
  if (!current(context) || !general_console_identity_read(current, context, &owner->console) || owner->console.uid != getuid() || identity->uid != owner->console.uid) goto fail;
  owner->count = 1; strcpy(owner->paths[0], "/");
  char home[PATH_MAX]; strcpy(home, owner->console.home);
  if (home[0] != '/' || home[1] == 0) goto fail;
  char *part = home + 1;
  for (char *end = part;; end++) if (*end == '/' || !*end) {
    bool last = !*end; *end = 0;
    if (!add(owner, part)) goto fail;
    if (last) break;
    part = end + 1;
  }
  owner->home_index = owner->count - 1;
  if (!add(owner, "Library") || !add(owner, "Application Support")) goto fail;
  owner->private_start = owner->count;
  if (!add(owner, "KoinCodeProtectedWallet") || !add(owner, "v1") || !add(owner, "e") || !add(owner, identity->enrollment_id) || !add(owner, "native")) goto fail;
  for (unsigned i = 0; i < owner->count; i++) {
    if (!snapshot(&op)) goto fail;
    bool created = false; struct stat named;
    if (i && fstatat(owner->nodes[i - 1], owner->names[i], &named, AT_SYMLINK_NOFOLLOW)) {
      if (errno != ENOENT || !create || i < owner->private_start) goto fail;
      /* Once mkdir is attempted its outcome may be durable. Never retry it. */
      result = GENERAL_NATIVE_DIRECTORY_UNCERTAIN;
      if (mkdirat(owner->nodes[i - 1], owner->names[i], 0700)) goto fail;
      if (fstatat(owner->nodes[i - 1], owner->names[i], &named, AT_SYMLINK_NOFOLLOW) || !S_ISDIR(named.st_mode) || named.st_uid != owner->console.uid) goto fail;
      created = true;
    } else if (create && i >= owner->count - 2) goto fail;
    int flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC;
    if (!snapshot(&op)) goto fail;
    owner->nodes[i] = i ? openat(owner->nodes[i - 1], owner->names[i], flags) : open("/", flags);
    if (owner->nodes[i] < 0) goto fail;
    if (fstat(owner->nodes[i], &owner->ids[i])) { owner->poisoned = true; goto fail; }
    owner->known[i] = true;
    if (i && !same(&named, &owner->ids[i])) goto fail;
    if (created && (fchmod(owner->nodes[i], 0700) || !snapshot(&op) || fsync(owner->nodes[i]) || !snapshot(&op) || fsync(owner->nodes[i - 1]))) goto fail;
    if (!snapshot(&op)) goto fail;
  }
  owner->ready = true; *out = owner; return GENERAL_NATIVE_DIRECTORY_READY;
fail:
  if (!general_native_directory_close(&owner)) { *out = owner; return GENERAL_NATIVE_DIRECTORY_UNCERTAIN; }
  return result;
}
bool general_native_directory_current(general_native_directory *owner) {
  if (!owner || !owner->ready || owner->running || owner->poisoned) return false;
  owner->running = true; operation op; bool valid = begin(owner, &op) && snapshot(&op);
  owner->running = false; return valid;
}
bool general_native_directory_borrow(general_native_directory *owner, int *directory) {
  if (!directory || !owner || owner->loan || !general_native_directory_current(owner)) return false;
  owner->loan = true; *directory = owner->nodes[owner->count - 1]; return true;
}
bool general_native_directory_matches(general_native_directory *owner, const general_native_identity *identity) {
  if (!identity || !general_native_identity_valid(identity) || !general_native_directory_current(owner)) return false;
  const general_native_identity *actual = &owner->identity;
  return actual->uid == identity->uid && !strcmp(actual->owner_id, identity->owner_id) && !strcmp(actual->installation_id, identity->installation_id) &&
    !strcmp(actual->enrollment_id, identity->enrollment_id) && !strcmp(actual->initialization_id, identity->initialization_id) && !strcmp(actual->initialization_digest, identity->initialization_digest);
}
bool general_native_directory_return(general_native_directory *owner) {
  if (!owner || !owner->loan || owner->running || owner->poisoned) return false;
  owner->loan = false; return true;
}
bool general_native_directory_enrollment_borrow(general_native_directory *owner, int *directory) {
  if (!owner || !directory || owner->enrollment_loan || !general_native_directory_current(owner) || owner->count < 2 ||
      strcmp(owner->names[owner->count - 1], "native")) return false;
  owner->enrollment_loan = true; *directory = owner->nodes[owner->count - 2]; return true;
}
bool general_native_directory_enrollment_return(general_native_directory *owner) {
  if (!owner || !owner->enrollment_loan || owner->running || owner->poisoned) return false;
  owner->enrollment_loan = false; return true;
}
bool general_native_directory_transfer_lifetime(general_native_directory *owner, bool (*current)(void *), void *context) {
  if (!owner || !current || owner->loan || owner->enrollment_loan || owner->transfer_attempted || !general_native_directory_current(owner)) return false;
  owner->transfer_attempted = true;
  owner->running = true; bool valid = current(context); owner->running = false;
  if (!valid) return false;
  owner->current = current; owner->context = context;
  if (!general_native_directory_current(owner)) { owner->poisoned = true; return false; }
  return true;
}
bool general_native_directory_close(general_native_directory **pointer) {
  if (!pointer || !*pointer) return true;
  general_native_directory *owner = *pointer;
  if (owner->loan || owner->enrollment_loan || owner->running || owner->poisoned) return false;
  for (unsigned i = owner->count; i > 0; i--) if (owner->nodes[i - 1] >= 0) {
    int fd = owner->nodes[i - 1]; owner->nodes[i - 1] = -1;
    if (close(fd)) { owner->poisoned = true; return false; }
  }
  memset(owner, 0, sizeof(*owner)); free(owner); *pointer = NULL; atomic_flag_clear(&occupied); return true;
}
