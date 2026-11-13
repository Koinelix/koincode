#include "root-namespace.h"
#include "session-lock.h"
#include "protected-acl.h"
#include "session-code.h"
#include "bundle-resources.h"
#include <fcntl.h>
#include <stdio.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static atomic_flag occupied = ATOMIC_FLAG_INIT;
static const char *const components[] = { "", "Library", "KoinCodeProtectedWallet", "users" };
struct general_root_namespace {
  int nodes[7]; /* Five directories, installation receipt, original owner.lock. */
  struct stat ids[7]; bool known[7]; char paths[5][PATH_MAX], user_name[11];
  unsigned char receipt_bytes[GENERAL_SESSION_RECEIPT_MAX]; size_t receipt_size;
  general_console_identity console;
  general_session_installation receipt;
  general_session_locks *locks;
  general_registration_io *records;
  struct timespec started;
  general_root_preparation preparation;
  bool ready, attached, changed, poisoned, directory_loan, records_loan;
};
typedef struct { general_root_namespace *owner; bool (*current)(void *); void *context; struct timespec started, last; } operation;
static bool root(void) { return getuid() == 0 && geteuid() == 0; }
static bool before(const struct timespec *left, const struct timespec *right) { return left->tv_sec < right->tv_sec || (left->tv_sec == right->tv_sec && left->tv_nsec < right->tv_nsec); }
static bool within(const struct timespec *now, const struct timespec *start, time_t seconds) {
  return now->tv_nsec >= 0 && now->tv_nsec < 1000000000 && !before(now, start) &&
    (now->tv_sec - start->tv_sec < seconds || (now->tv_sec - start->tv_sec == seconds && now->tv_nsec < start->tv_nsec));
}
static bool alive(void *context) {
  general_root_namespace *owner = context; struct timespec now;
  return owner && !owner->poisoned && root() && !clock_gettime(CLOCK_MONOTONIC, &now) && within(&now, &owner->started, 360);
}
static bool node_current(general_root_namespace *owner, unsigned index);
static bool active(void *context) {
  operation *op = context; struct timespec now;
  if (!op->current(op->context) || !alive(op->owner) || clock_gettime(CLOCK_MONOTONIC, &now) || before(&now, &op->last) || !within(&now, &op->started, 30)) return false;
  op->last = now;
  for (unsigned i = 0; i < 7; i++) if (op->owner->known[i] && !node_current(op->owner, i)) return false;
  return !op->owner->locks || general_session_locks_installation_current(op->owner->locks);
}
static bool same(const struct stat *left, const struct stat *right) { return left->st_dev == right->st_dev && left->st_ino == right->st_ino; }
static const char *name(general_root_namespace *owner, unsigned index) { return index < 4 ? components[index] : index == 4 ? owner->user_name : index == 5 ? "installation.plist" : "owner.lock"; }
static unsigned parent(unsigned index) { return index == 5 ? 2 : index == 6 ? 4 : index - 1; }
static bool protected(const struct stat *value, bool directory) {
  return value->st_uid == 0 && !(value->st_mode & 07022) && (directory ? S_ISDIR(value->st_mode) && value->st_nlink > 0 :
    S_ISREG(value->st_mode) && value->st_nlink == 1 && value->st_size >= 0 && value->st_size <= GENERAL_SESSION_RECEIPT_MAX);
}
static bool node_current(general_root_namespace *owner, unsigned index) {
  struct stat actual, named; char path[PATH_MAX]; int flags;
  if (!owner->known[index] || fstat(owner->nodes[index], &actual) || !same(&actual, &owner->ids[index]) || !protected(&actual, index < 5) ||
      (flags = fcntl(owner->nodes[index], F_GETFD)) < 0 || !(flags & FD_CLOEXEC) || !general_protected_acl_readonly(owner->nodes[index])) return false;
  if (index && (fstatat(owner->nodes[parent(index)], name(owner, index), &named, AT_SYMLINK_NOFOLLOW) || !protected(&named, index < 5) || !same(&actual, &named))) return false;
  return index >= 5 || (fcntl(owner->nodes[index], F_GETPATH, path) == 0 && !strcmp(path, owner->paths[index]));
}
static bool capture(general_root_namespace *owner, unsigned index, int fd) {
  owner->nodes[index] = fd; if (fd < 0) return false;
  if (fstat(fd, &owner->ids[index])) { owner->poisoned = true; return false; }
  owner->known[index] = true;
  if (index < 5 && fcntl(fd, F_GETPATH, owner->paths[index])) return false;
  return node_current(owner, index);
}
static bool open_node(general_root_namespace *owner, unsigned index) {
  int flags = O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC | (index < 5 ? O_DIRECTORY : 0);
  return capture(owner, index, index ? openat(owner->nodes[parent(index)], name(owner, index), flags) : open("/", flags));
}
static bool read_receipt(operation *op, unsigned char out[GENERAL_SESSION_RECEIPT_MAX], size_t *size) {
  struct stat actual; general_root_namespace *owner = op->owner;
  if (!active(op) || !node_current(owner, 5) || fstat(owner->nodes[5], &actual) || actual.st_size < 8 || actual.st_size > GENERAL_SESSION_RECEIPT_MAX) return false;
  size_t count = (size_t)actual.st_size, offset = 0; unsigned interrupted = 0;
  while (offset < count) {
    if (!active(op) || !node_current(owner, 5)) return false;
    ssize_t read = pread(owner->nodes[5], out + offset, count - offset, (off_t)offset);
    if (read < 0 && errno == EINTR && ++interrupted <= 64) continue;
    if (read <= 0 || (size_t)read > count - offset) return false;
    offset += (size_t)read;
  }
  if (!active(op) || !node_current(owner, 5) || fstat(owner->nodes[5], &actual) || (size_t)actual.st_size != count) return false;
  *size = count; return true;
}
static bool records_consistent(general_root_namespace *owner, const general_registration_view *view, bool fresh) {
  if (fresh) return !view->registration_present && !view->assignment_present;
  if (!view->registration_present) return false;
  const general_native_identity *id = &view->registration.identity;
  if (id->uid != owner->console.uid || strcmp(id->installation_id, owner->receipt.installation_id)) return false;
  if (view->registration.phase == GENERAL_REGISTRATION_RESERVED && view->assignment_present) return false;
  if (view->registration.phase == GENERAL_REGISTRATION_ASSIGNED && !view->assignment_present) return false;
  if (view->assignment_present) {
    const general_assignment *assignment = &view->assignment;
    if (assignment->uid != id->uid || strcmp(assignment->owner_id, id->owner_id) || strcmp(assignment->installation_id, id->installation_id) ||
        strcmp(assignment->initialization_id, id->initialization_id) || strcmp(assignment->enrollment_id, id->enrollment_id) || strcmp(assignment->initialization_digest, id->initialization_digest)) return false;
  }
  return true;
}
bool general_root_namespace_current(general_root_namespace *owner) {
  if (!owner || !owner->ready || !alive(owner) || !general_session_locks_installation_current(owner->locks) ||
      !general_session_code_self(GENERAL_CODE_PROVISIONER, &owner->receipt)) return false;
  for (unsigned i = 0; i < 7; i++) if (!node_current(owner, i)) return false;
  if (owner->attached && !general_session_locks_current(owner->locks)) return false;
  operation op = { .owner = owner, .current = alive, .context = owner };
  if (clock_gettime(CLOCK_MONOTONIC, &op.started)) return false;
  op.last = op.started; unsigned char bytes[GENERAL_SESSION_RECEIPT_MAX]; size_t size;
  return read_receipt(&op, bytes, &size) && size == owner->receipt_size && !memcmp(bytes, owner->receipt_bytes, size) &&
    general_console_identity_matches(&owner->console, active, &op) && active(&op);
}
static general_root_namespace_result finish_failure(general_root_namespace *owner, general_root_namespace_result result, general_root_namespace **out) {
  owner->ready = false;
  if (owner->changed || owner->poisoned) { owner->poisoned = true; *out = owner; return GENERAL_ROOT_NAMESPACE_UNCERTAIN; }
  if (!general_root_namespace_close(&owner)) { *out = owner; return GENERAL_ROOT_NAMESPACE_UNCERTAIN; }
  return result;
}
general_root_namespace_result general_root_namespace_prepare(bool (*current)(void *), void *context, general_root_namespace **out) {
  if (!out || *out || !current || !root()) return GENERAL_ROOT_NAMESPACE_UNAVAILABLE;
  if (atomic_flag_test_and_set(&occupied)) return GENERAL_ROOT_NAMESPACE_BUSY;
  general_root_namespace *owner = calloc(1, sizeof(*owner));
  if (!owner) { atomic_flag_clear(&occupied); return GENERAL_ROOT_NAMESPACE_UNAVAILABLE; }
  for (unsigned i = 0; i < 7; i++) owner->nodes[i] = -1;
  if (clock_gettime(CLOCK_MONOTONIC, &owner->started)) return finish_failure(owner, GENERAL_ROOT_NAMESPACE_UNAVAILABLE, out);
  operation op = { .owner = owner, .current = current, .context = context, .started = owner->started, .last = owner->started };
  general_root_namespace_result result = GENERAL_ROOT_NAMESPACE_UNAVAILABLE;
  for (unsigned i = 0; i < 3; i++) if (!active(&op) || !open_node(owner, i)) goto fail;
  general_session_lock_result lock = general_session_locks_enrollment_begin(owner->nodes[2], active, &op, &owner->locks);
  if (lock != GENERAL_SESSION_LOCK_READY) { result = lock == GENERAL_SESSION_LOCK_BUSY ? GENERAL_ROOT_NAMESPACE_BUSY : GENERAL_ROOT_NAMESPACE_UNAVAILABLE; goto fail; }
  if (!active(&op) || !open_node(owner, 5) || !read_receipt(&op, owner->receipt_bytes, &owner->receipt_size) ||
      !general_parse_session_installation(owner->receipt_bytes, owner->receipt_size, &owner->receipt) ||
      !general_session_code_self(GENERAL_CODE_PROVISIONER, &owner->receipt) || !active(&op)) goto fail;
  general_bundle_resource_result distribution = general_bundle_resources_check(&owner->receipt, active, &op);
  if (distribution != GENERAL_BUNDLE_RESOURCE_CHECKED) { if (distribution == GENERAL_BUNDLE_RESOURCE_UNCERTAIN) owner->poisoned = true; goto fail; }
  if (!active(&op) || !general_console_identity_read(active, &op, &owner->console) || !owner->console.uid || owner->console.uid == UINT32_MAX || !open_node(owner, 3)) goto fail;
  int count = snprintf(owner->user_name, sizeof(owner->user_name), "%u", owner->console.uid);
  if (count < 1 || count >= (int)sizeof(owner->user_name) || !active(&op)) goto fail;
  int fd = openat(owner->nodes[3], owner->user_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  bool fresh = false;
  if (fd < 0) {
    if (errno != ENOENT) { result = GENERAL_ROOT_NAMESPACE_CONFLICT; goto fail; }
    if (!active(&op)) goto fail;
    int created = mkdirat(owner->nodes[3], owner->user_name, 0755);
    if (created && errno == EEXIST) { result = GENERAL_ROOT_NAMESPACE_CONFLICT; goto fail; }
    owner->changed = true;
    if (created || !active(&op)) goto fail;
    fd = openat(owner->nodes[3], owner->user_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    fresh = true;
  }
  if (!capture(owner, 4, fd) || !active(&op)) goto fail;
  if (fresh) {
    if (fchmod(owner->nodes[4], 0755) || !active(&op) || !node_current(owner, 4)) goto fail;
    fd = openat(owner->nodes[4], "owner.lock", O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0644);
    if (!capture(owner, 6, fd) || !active(&op) || fchmod(owner->nodes[6], 0644) || !active(&op) || !node_current(owner, 6) ||
        fsync(owner->nodes[6]) || !active(&op) || fsync(owner->nodes[4]) || !active(&op) || fsync(owner->nodes[3]) || !active(&op)) goto fail;
  } else if (!open_node(owner, 6) || !active(&op)) { result = GENERAL_ROOT_NAMESPACE_CONFLICT; goto fail; }
  owner->records = general_registration_io_create(owner->nodes[4]);
  general_registration_view view;
  if (!owner->records || !general_registration_io_inspect(owner->records, active, &op, &view) || !records_consistent(owner, &view, fresh)) { result = GENERAL_ROOT_NAMESPACE_CONFLICT; goto fail; }
  owner->preparation = fresh ? GENERAL_ROOT_PREPARATION_FRESH : GENERAL_ROOT_PREPARATION_RESUME; owner->ready = true;
  if (!general_root_namespace_current(owner) || !active(&op)) goto fail;
  *out = owner; return GENERAL_ROOT_NAMESPACE_READY;
fail:
  return finish_failure(owner, result, out);
}
bool general_root_namespace_info(general_root_namespace *owner, general_console_identity *identity, general_session_installation *receipt, general_root_preparation *preparation) {
  if (!identity || !receipt || !preparation || !general_root_namespace_current(owner)) return false;
  *identity = owner->console; *receipt = owner->receipt; *preparation = owner->preparation; return true;
}
general_root_namespace_result general_root_namespace_adopt_owner(general_root_namespace *owner, int *received, bool (*current)(void *), void *context) {
  if (!current || !received || *received < 0 || !general_root_namespace_current(owner) || owner->attached) return GENERAL_ROOT_NAMESPACE_UNAVAILABLE;
  general_session_lock_result result = general_session_locks_enrollment_adopt(owner->locks, owner->nodes[4], received, current, context);
  if (result == GENERAL_SESSION_LOCK_UNCERTAIN) { owner->poisoned = true; return GENERAL_ROOT_NAMESPACE_UNCERTAIN; }
  if (result != GENERAL_SESSION_LOCK_READY) return result == GENERAL_SESSION_LOCK_BUSY ? GENERAL_ROOT_NAMESPACE_BUSY : GENERAL_ROOT_NAMESPACE_UNAVAILABLE;
  owner->attached = true;
  if (general_root_namespace_current(owner) && current(context)) return GENERAL_ROOT_NAMESPACE_READY;
  owner->ready = false; return GENERAL_ROOT_NAMESPACE_UNAVAILABLE;
}
int general_root_namespace_borrow_directory(general_root_namespace *owner) {
  if (!general_root_namespace_current(owner) || owner->directory_loan) return -1;
  owner->directory_loan = true; return owner->nodes[4];
}
bool general_root_namespace_return_directory(general_root_namespace *owner) { if (!owner || !owner->directory_loan) return false; owner->directory_loan = false; return true; }
general_registration_io *general_root_namespace_borrow_records(general_root_namespace *owner) {
  if (!general_root_namespace_current(owner) || !owner->attached || owner->records_loan) return NULL;
  owner->records_loan = true; return owner->records;
}
bool general_root_namespace_return_records(general_root_namespace *owner) { if (!owner || !owner->records_loan) return false; owner->records_loan = false; return true; }
bool general_root_namespace_close(general_root_namespace **pointer) {
  if (!pointer || !*pointer) return true;
  general_root_namespace *owner = *pointer;
  if (owner->poisoned || owner->directory_loan || owner->records_loan) return false;
  owner->ready = false;
  if (!general_registration_io_close(&owner->records)) { owner->poisoned = true; return false; }
  for (int i = 6; i >= 0; i--) {
    if (owner->nodes[i] < 0) continue; struct stat value;
    if (!owner->known[i] || fstat(owner->nodes[i], &value) || !same(&value, &owner->ids[i]) || ((value.st_mode ^ owner->ids[i].st_mode) & S_IFMT)) owner->poisoned = true;
    else { int fd = owner->nodes[i]; owner->nodes[i] = -1; if (close(fd)) owner->poisoned = true; }
  }
  if (owner->poisoned || !general_session_locks_close(&owner->locks)) { owner->poisoned = true; return false; }
  free(owner); *pointer = NULL; atomic_flag_clear(&occupied); return true;
}
