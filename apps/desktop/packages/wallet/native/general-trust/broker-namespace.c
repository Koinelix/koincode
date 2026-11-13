#include "broker-namespace.h"
#include "protected-acl.h"
#include "session-code.h"
#include "bundle-resources.h"
#include <fcntl.h>
#include <limits.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static atomic_flag occupied = ATOMIC_FLAG_INIT;
static const char *const names[] = { "", "Library", "KoinCodeProtectedWallet", "users" };
struct general_broker_namespace {
  int nodes[6], reading; struct stat ids[6], reading_id; bool known[6], reading_known;
  char paths[5][PATH_MAX], user[11]; uid_t uid;
  unsigned char receipt_bytes[GENERAL_SESSION_RECEIPT_MAX]; size_t receipt_size;
  general_console_identity console; general_session_installation receipt;
  general_session_locks *locks;
  bool ready, loan, child_loan, running, code_checked, poisoned, user_released;
  bool (*current)(void *); void *context;
};
typedef struct { general_broker_namespace *owner; struct timespec started, last; } operation;
static bool same(const struct stat *left, const struct stat *right) { return left->st_dev == right->st_dev && left->st_ino == right->st_ino && !((left->st_mode ^ right->st_mode) & S_IFMT); }
static bool protected(const struct stat *value, bool directory) {
  return value->st_uid == 0 && !(value->st_mode & 07022) && (directory ? S_ISDIR(value->st_mode) && value->st_nlink > 0 :
    S_ISREG(value->st_mode) && value->st_nlink == 1 && value->st_size >= 0 && value->st_size <= GENERAL_SESSION_RECEIPT_MAX);
}
static bool role(general_broker_namespace *owner) { return owner->uid > 0 && owner->uid < UINT32_MAX && getuid() == owner->uid && geteuid() == owner->uid; }
static bool node_current(general_broker_namespace *owner, unsigned index) {
  struct stat actual, named; char path[PATH_MAX]; int flags;
  if (!owner->known[index] || fstat(owner->nodes[index], &actual) || !same(&actual, &owner->ids[index]) || !protected(&actual, index < 5) ||
      (flags = fcntl(owner->nodes[index], F_GETFD)) < 0 || !(flags & FD_CLOEXEC) || !general_protected_acl_readonly(owner->nodes[index])) return false;
  if (index && (fstatat(owner->nodes[index == 5 ? 2 : index - 1], index == 5 ? "installation.plist" : index == 4 ? owner->user : names[index], &named, AT_SYMLINK_NOFOLLOW) ||
      !protected(&named, index < 5) || !same(&actual, &named))) return false;
  return index >= 5 || (!fcntl(owner->nodes[index], F_GETPATH, path) && !strcmp(path, owner->paths[index]));
}
static bool active(void *context) {
  operation *op = context; general_broker_namespace *owner = op->owner; struct timespec now;
  if (owner->poisoned || !role(owner) || !owner->current(owner->context)) return false;
  for (unsigned i = 0; i < 6; i++) if (owner->known[i] && !node_current(owner, i)) return false;
  if ((owner->locks && !(owner->user_released ? general_session_locks_installation_current(owner->locks) : general_session_locks_current(owner->locks))) || (owner->code_checked && !general_session_code_self(GENERAL_CODE_BROKER, &owner->receipt)) ||
      clock_gettime(CLOCK_MONOTONIC, &now) || now.tv_nsec < 0 || now.tv_nsec >= 1000000000 || now.tv_sec < op->last.tv_sec ||
      (now.tv_sec == op->last.tv_sec && now.tv_nsec < op->last.tv_nsec) || now.tv_sec < op->started.tv_sec ||
      now.tv_sec - op->started.tv_sec > 30 || (now.tv_sec - op->started.tv_sec == 30 && now.tv_nsec >= op->started.tv_nsec)) return false;
  op->last = now; return true;
}
static bool begin(general_broker_namespace *owner, operation *op) {
  *op = (operation){ .owner = owner };
  if (clock_gettime(CLOCK_MONOTONIC, &op->started)) return false;
  op->last = op->started; return active(op);
}
static bool capture(general_broker_namespace *owner, unsigned index, int fd) {
  owner->nodes[index] = fd; if (fd < 0) return false;
  if (fstat(fd, &owner->ids[index])) { owner->poisoned = true; return false; }
  owner->known[index] = true;
  return node_current(owner, index);
}
static bool read_bytes(operation *op, int fd, const struct stat *identity, unsigned char *bytes, size_t *size) {
  struct stat actual;
  if (!active(op) || fstat(fd, &actual) || !same(&actual, identity) || !protected(&actual, false) || actual.st_size < 8) return false;
  size_t length = (size_t)actual.st_size, offset = 0; unsigned interrupted = 0;
  while (offset < length) {
    if (!active(op)) return false;
    ssize_t count = pread(fd, bytes + offset, length - offset, (off_t)offset);
    if (count < 0 && errno == EINTR && ++interrupted <= 64) continue;
    if (count <= 0 || (size_t)count > length - offset) return false;
    offset += (size_t)count;
  }
  if (!active(op) || fstat(fd, &actual) || !same(&actual, identity) || !protected(&actual, false) || (size_t)actual.st_size != length) return false;
  *size = length; return true;
}
static bool receipt_current(operation *op) {
  unsigned char bytes[GENERAL_SESSION_RECEIPT_MAX]; size_t size;
  return read_bytes(op, op->owner->nodes[5], &op->owner->ids[5], bytes, &size) && size == op->owner->receipt_size && !memcmp(bytes, op->owner->receipt_bytes, size);
}
static bool snapshot_current(operation *op) {
  return active(op) && receipt_current(op) && general_console_identity_matches(&op->owner->console, active, op) && active(op);
}
bool general_broker_namespace_current(general_broker_namespace *owner) {
  if (!owner || !owner->ready || owner->user_released || owner->running || owner->poisoned) return false;
  owner->running = true; operation op;
  bool valid = begin(owner, &op) && snapshot_current(&op);
  owner->running = false; return valid;
}
static general_broker_namespace_result open_namespace(bool (*current)(void *), void *context, general_broker_namespace **out, bool inspection) {
  uid_t uid = getuid();
  if (!current || !out || *out || !uid || uid == UINT32_MAX || geteuid() != uid) return GENERAL_BROKER_NAMESPACE_UNAVAILABLE;
  if (atomic_flag_test_and_set(&occupied)) return GENERAL_BROKER_NAMESPACE_BUSY;
  general_broker_namespace *owner = calloc(1, sizeof(*owner));
  if (!owner) { atomic_flag_clear(&occupied); return GENERAL_BROKER_NAMESPACE_UNAVAILABLE; }
  for (unsigned i = 0; i < 6; i++) owner->nodes[i] = -1;
  owner->reading = -1; owner->uid = uid; owner->current = current; owner->context = context;
  general_broker_namespace_result result = GENERAL_BROKER_NAMESPACE_UNAVAILABLE; operation op;
  if (!begin(owner, &op) || !general_console_identity_read(active, &op, &owner->console) || owner->console.uid != uid) goto fail;
  int length = snprintf(owner->user, sizeof(owner->user), "%u", uid);
  if (length < 1 || length >= (int)sizeof(owner->user)) goto fail;
  const char *paths[] = { "/", "/Library", "/Library/KoinCodeProtectedWallet", "/Library/KoinCodeProtectedWallet/users" };
  for (unsigned i = 0; i < 5; i++) {
    if (i < 4) strcpy(owner->paths[i], paths[i]);
    else { length = snprintf(owner->paths[i], sizeof(owner->paths[i]), "%s/%s", paths[3], owner->user); if (length < 1 || length >= (int)sizeof(owner->paths[i])) goto fail; }
    if (!active(&op)) goto fail;
    int flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC;
    if (!capture(owner, i, i ? openat(owner->nodes[i - 1], i == 4 ? owner->user : names[i], flags) : open("/", flags))) goto fail;
  }
  if (!active(&op) || !capture(owner, 5, openat(owner->nodes[2], "installation.plist", O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)) ||
      !read_bytes(&op, owner->nodes[5], &owner->ids[5], owner->receipt_bytes, &owner->receipt_size) ||
      !general_parse_session_installation(owner->receipt_bytes, owner->receipt_size, &owner->receipt)) goto fail;
  general_session_lock_result locked = inspection ? general_session_locks_broker_inspection_open(owner->nodes[2], owner->nodes[4], active, &op, &owner->locks) :
    general_session_locks_broker_open(owner->nodes[2], owner->nodes[4], active, &op, &owner->locks);
  if (locked != GENERAL_SESSION_LOCK_READY) { result = locked == GENERAL_SESSION_LOCK_BUSY ? GENERAL_BROKER_NAMESPACE_BUSY : result; goto fail; }
  if (!snapshot_current(&op) || !general_session_code_self(GENERAL_CODE_BROKER, &owner->receipt)) goto fail;
  owner->code_checked = true;
  general_bundle_resource_result checked = general_bundle_resources_check(&owner->receipt, active, &op);
  if (checked == GENERAL_BUNDLE_RESOURCE_UNCERTAIN) { owner->poisoned = true; goto fail; }
  if (checked != GENERAL_BUNDLE_RESOURCE_CHECKED || !snapshot_current(&op)) goto fail;
  owner->ready = true; *out = owner; return GENERAL_BROKER_NAMESPACE_READY;
fail:
  if (!general_broker_namespace_close(&owner)) { *out = owner; return GENERAL_BROKER_NAMESPACE_UNCERTAIN; }
  return result;
}
general_broker_namespace_result general_broker_namespace_open(bool (*current)(void *), void *context, general_broker_namespace **out) {
  return open_namespace(current, context, out, false);
}
general_broker_namespace_result general_broker_namespace_open_inspection(bool (*current)(void *), void *context, general_broker_namespace **out) {
  return open_namespace(current, context, out, true);
}
bool general_broker_namespace_info(general_broker_namespace *owner, general_console_identity *console, general_session_installation *receipt) {
  if (!console || !receipt || !general_broker_namespace_current(owner)) return false;
  *console = owner->console; *receipt = owner->receipt; return true;
}
static bool close_reading(general_broker_namespace *owner) {
  if (owner->reading < 0) return true;
  struct stat actual;
  if (!owner->reading_known || fstat(owner->reading, &actual) || !same(&actual, &owner->reading_id)) { owner->poisoned = true; return false; }
  int fd = owner->reading; owner->reading = -1; owner->reading_known = false;
  if (close(fd)) { owner->poisoned = true; return false; } return true;
}
static bool read_record(operation *op, const char *name, unsigned char *bytes, size_t *size, bool *present) {
  general_broker_namespace *owner = op->owner; struct stat named, after; bool valid = false;
  if (!snapshot_current(op)) return false;
  if (fstatat(owner->nodes[4], name, &named, AT_SYMLINK_NOFOLLOW)) { if (errno == ENOENT && snapshot_current(op)) { *present = false; return true; } return false; }
  if (!protected(&named, false)) return false;
  owner->reading = openat(owner->nodes[4], name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (owner->reading < 0) return false;
  if (fstat(owner->reading, &owner->reading_id)) { owner->poisoned = true; return false; }
  owner->reading_known = true;
  int flags = fcntl(owner->reading, F_GETFD);
  if (flags >= 0 && (flags & FD_CLOEXEC) && same(&owner->reading_id, &named) && general_protected_acl_readonly(owner->reading) &&
      read_bytes(op, owner->reading, &named, bytes, size) && !fstatat(owner->nodes[4], name, &after, AT_SYMLINK_NOFOLLOW) &&
      protected(&after, false) && same(&named, &after) && snapshot_current(op)) valid = true;
  if (!close_reading(owner)) return false;
  if (valid) *present = true; return valid;
}
static bool consistent(general_broker_namespace *owner, const general_registration_view *view) {
  if (!view->registration_present) return !view->assignment_present;
  const general_native_identity *id = &view->registration.identity;
  if (id->uid != owner->console.uid || strcmp(id->installation_id, owner->receipt.installation_id) ||
      (view->registration.phase == GENERAL_REGISTRATION_RESERVED && view->assignment_present) ||
      (view->registration.phase == GENERAL_REGISTRATION_ASSIGNED && !view->assignment_present)) return false;
  if (!view->assignment_present) return true;
  const general_assignment *assignment = &view->assignment;
  return assignment->uid == id->uid && !strcmp(assignment->owner_id, id->owner_id) && !strcmp(assignment->installation_id, id->installation_id) &&
    !strcmp(assignment->enrollment_id, id->enrollment_id) && !strcmp(assignment->initialization_id, id->initialization_id) && !strcmp(assignment->initialization_digest, id->initialization_digest);
}
bool general_broker_namespace_inspect(general_broker_namespace *owner, general_registration_view *out) {
  if (!owner || !out || !owner->ready || owner->user_released || owner->running || owner->poisoned) return false;
  owner->running = true; operation op; bool valid = false; general_registration_view parsed = {0};
  unsigned char bytes[GENERAL_SESSION_RECEIPT_MAX]; size_t size;
  if (!begin(owner, &op) || !read_record(&op, "registration.plist", bytes, &size, &parsed.registration_present) ||
      (parsed.registration_present && !general_registration_record_parse(bytes, size, &parsed.registration)) ||
      !read_record(&op, "assignment.plist", bytes, &size, &parsed.assignment_present) ||
      (parsed.assignment_present && !general_parse_assignment(bytes, size, owner->console.uid, owner->receipt.installation_id, &parsed.assignment)) || !consistent(owner, &parsed) || !snapshot_current(&op)) goto done;
  *out = parsed; valid = true;
done:
  owner->running = false; return valid;
}
bool general_broker_namespace_borrow(general_broker_namespace *owner, int *directory, general_session_locks **locks) {
  if (!owner || owner->loan || !directory || *directory >= 0 || !locks || *locks || !general_broker_namespace_current(owner)) return false;
  owner->loan = true; *directory = owner->nodes[4]; *locks = owner->locks; return true;
}
bool general_broker_namespace_return(general_broker_namespace *owner) {
  if (!owner || !owner->loan || owner->running || owner->poisoned) return false;
  owner->loan = false; return true;
}
bool general_broker_namespace_borrow_child(general_broker_namespace *owner) {
  if (!owner || owner->child_loan || !general_broker_namespace_current(owner)) return false;
  owner->child_loan = true; return true;
}
bool general_broker_namespace_return_child(general_broker_namespace *owner) {
  if (!owner || !owner->child_loan || owner->running || owner->poisoned) return false;
  owner->child_loan = false; return true;
}
bool general_broker_namespace_release_user(general_broker_namespace *owner) {
  if (!owner || !owner->ready || owner->user_released || owner->running || owner->poisoned || owner->loan || owner->child_loan || !close_reading(owner)) return false;
  if (!general_session_locks_release_user(owner->locks)) { owner->poisoned = true; return false; }
  owner->user_released = true; return true;
}
bool general_broker_namespace_installation_current(general_broker_namespace *owner) {
  if (!owner || !owner->ready || !owner->user_released || owner->running || owner->poisoned) return false;
  owner->running = true; operation op;
  bool valid = begin(owner, &op) && snapshot_current(&op);
  owner->running = false; return valid;
}
bool general_broker_namespace_close(general_broker_namespace **pointer) {
  if (!pointer || !*pointer) return true;
  general_broker_namespace *owner = *pointer;
  if (owner->loan || owner->child_loan || owner->running || owner->poisoned || !close_reading(owner)) return false;
  owner->ready = false;
  for (unsigned step = 0; step < 6; step++) {
    unsigned i = step == 0 ? 5 : 5 - step;
    if (owner->nodes[i] < 0) continue;
    struct stat actual;
    if (!owner->known[i] || fstat(owner->nodes[i], &actual) || !same(&actual, &owner->ids[i])) { owner->poisoned = true; return false; }
    int fd = owner->nodes[i]; owner->nodes[i] = -1;
    if (close(fd)) { owner->poisoned = true; return false; }
  }
  if (!general_session_locks_close(&owner->locks)) { owner->poisoned = true; return false; }
  free(owner); *pointer = NULL; atomic_flag_clear(&occupied); return true;
}
