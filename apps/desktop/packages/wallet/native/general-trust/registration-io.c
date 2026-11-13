#include "registration-io.h"
#include "protected-acl.h"
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <sys/acl.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static atomic_flag held = ATOMIC_FLAG_INIT;
static const char *const names[] = { "registration.plist", "assignment.plist" };
struct general_registration_io {
  int directory, files[2];
  struct stat identities[3];
  char path[PATH_MAX];
  bool known[3], pending, poisoned, close_uncertain;
};
typedef struct { general_registration_io *owner; bool (*current)(void *); void *context; struct timespec started, last; unsigned interrupted; bool changed; } operation;
static bool same(const struct stat *left, const struct stat *right) { return left->st_dev == right->st_dev && left->st_ino == right->st_ino; }
static bool root(void) { return getuid() == 0 && geteuid() == 0; }
static bool protected_entry(const struct stat *entry, bool directory) {
  return entry->st_uid == 0 && !(entry->st_mode & 07022) && (directory ? S_ISDIR(entry->st_mode) && entry->st_nlink > 0 :
    S_ISREG(entry->st_mode) && entry->st_nlink == 1 && entry->st_size >= 0 && entry->st_size <= GENERAL_REGISTRATION_RECORD_MAX);
}
static bool descriptor(int fd) { int flags = fcntl(fd, F_GETFD); return flags >= 0 && (flags & FD_CLOEXEC); }
static bool directory_current(general_registration_io *owner) {
  struct stat actual; char path[PATH_MAX];
  return root() && owner && !owner->close_uncertain && owner->known[0] && fstat(owner->directory, &actual) == 0 &&
    protected_entry(&actual, true) && same(&actual, &owner->identities[0]) && descriptor(owner->directory) &&
    fcntl(owner->directory, F_GETPATH, path) == 0 && !strcmp(path, owner->path) && general_protected_acl_readonly(owner->directory);
}
static bool file_current(general_registration_io *owner, unsigned role) {
  struct stat actual, named;
  return directory_current(owner) && owner->files[role] >= 0 && owner->known[role + 1] &&
    fstat(owner->files[role], &actual) == 0 && protected_entry(&actual, false) && same(&actual, &owner->identities[role + 1]) &&
    fstatat(owner->directory, names[role], &named, AT_SYMLINK_NOFOLLOW) == 0 && protected_entry(&named, false) && same(&actual, &named) &&
    actual.st_size == named.st_size && descriptor(owner->files[role]) && general_protected_acl_readonly(owner->files[role]);
}
static bool active(operation *op) {
  struct timespec now;
  if (!op->current(op->context) || !directory_current(op->owner) || clock_gettime(CLOCK_MONOTONIC, &now)) return false;
  if (now.tv_sec < op->last.tv_sec || (now.tv_sec == op->last.tv_sec && now.tv_nsec < op->last.tv_nsec) || now.tv_nsec < 0 || now.tv_nsec >= 1000000000) return false;
  op->last = now;
  time_t seconds = now.tv_sec - op->started.tv_sec;
  return seconds >= 0 && (seconds < 30 || (seconds == 30 && now.tv_nsec < op->started.tv_nsec));
}
static bool begin(general_registration_io *owner, bool (*current)(void *), void *context, operation *op) {
  if (!owner || !current || owner->pending || owner->poisoned || owner->close_uncertain) return false;
  owner->pending = true; *op = (operation){ .owner = owner, .current = current, .context = context };
  if (!clock_gettime(CLOCK_MONOTONIC, &op->started)) { op->last = op->started; if (active(op)) return true; }
  owner->pending = false; return false;
}
static general_registration_io_result end(operation *op, bool ok) {
  bool uncertain = op->changed || op->owner->close_uncertain;
  if (!ok && uncertain) op->owner->poisoned = true;
  op->owner->pending = false;
  return ok ? GENERAL_REGISTRATION_IO_COMPLETE : uncertain ? GENERAL_REGISTRATION_IO_UNCERTAIN : GENERAL_REGISTRATION_IO_REJECTED;
}
/* Returns 1 for a held file, 0 for genuinely absent, -1 for conflict/error. */
static int acquire(operation *op, unsigned role) {
  general_registration_io *owner = op->owner;
  if (!active(op)) return -1;
  if (owner->files[role] >= 0) return file_current(owner, role) ? 1 : -1;
  int fd = openat(owner->directory, names[role], O_RDWR | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) return errno == ENOENT && active(op) ? 0 : -1;
  owner->files[role] = fd;
  if (!fstat(fd, &owner->identities[role + 1])) owner->known[role + 1] = true;
  if (!owner->known[role + 1]) { owner->close_uncertain = true; return -1; }
  return file_current(owner, role) && active(op) ? 1 : -1;
}
static bool read_file(operation *op, unsigned role, unsigned char out[GENERAL_REGISTRATION_RECORD_MAX], size_t *size) {
  struct stat actual; general_registration_io *owner = op->owner;
  if (!active(op) || !file_current(owner, role) || fstat(owner->files[role], &actual) || !protected_entry(&actual, false) || actual.st_size < 1) return false;
  size_t length = (size_t)actual.st_size, offset = 0;
  while (offset < length) {
    if (!active(op) || !file_current(owner, role)) return false;
    ssize_t count = pread(owner->files[role], out + offset, length - offset, (off_t)offset);
    if (count < 0 && errno == EINTR && ++op->interrupted <= 64) continue;
    if (count <= 0 || (size_t)count > length - offset) return false;
    offset += (size_t)count;
  }
  if (!active(op) || !file_current(owner, role) || fstat(owner->files[role], &actual) || (size_t)actual.st_size != length) return false;
  *size = length; return true;
}
static bool snapshot(operation *op, general_registration_view *out) {
  general_registration_view view = {0}; unsigned char bytes[GENERAL_REGISTRATION_RECORD_MAX]; size_t size;
  int registration = acquire(op, 0), assignment = acquire(op, 1);
  if (registration < 0 || assignment < 0) return false;
  if (registration) {
    if (!read_file(op, 0, bytes, &size) || !general_registration_record_parse(bytes, size, &view.registration)) return false;
    view.registration_present = true;
  }
  if (assignment) {
    if (!read_file(op, 1, bytes, &size) || !view.registration_present ||
        !general_parse_assignment(bytes, size, view.registration.identity.uid, view.registration.identity.installation_id, &view.assignment)) return false;
    view.assignment_present = true;
  }
  if (!active(op)) return false;
  *out = view; return true;
}
static bool assignment_matches(const general_assignment *assignment, const general_initialization_plan *plan) {
  const general_native_identity *identity = &plan->identity;
  return assignment->uid == identity->uid && !strcmp(assignment->owner_id, identity->owner_id) && !strcmp(assignment->installation_id, identity->installation_id) &&
    !strcmp(assignment->enrollment_id, identity->enrollment_id) && !strcmp(assignment->initialization_id, identity->initialization_id) && !strcmp(assignment->initialization_digest, identity->initialization_digest);
}
static bool create_file(operation *op, unsigned role) {
  if (!active(op) || op->owner->files[role] >= 0) return false;
  int fd = openat(op->owner->directory, names[role], O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0644);
  if (fd < 0 && errno == EEXIST) return false;
  op->changed = true;
  if (fd < 0) return false;
  op->owner->files[role] = fd;
  if (fstat(fd, &op->owner->identities[role + 1])) { op->owner->close_uncertain = true; return false; }
  op->owner->known[role + 1] = true;
  return active(op) && file_current(op->owner, role) && fchmod(fd, 0644) == 0 && active(op) && file_current(op->owner, role);
}
static bool write_file(operation *op, unsigned role, const unsigned char *bytes, size_t size) {
  size_t offset = 0;
  while (offset < size) {
    if (!active(op) || !file_current(op->owner, role)) return false;
    op->changed = true;
    ssize_t count = pwrite(op->owner->files[role], bytes + offset, size - offset, (off_t)offset);
    if (count <= 0 || (size_t)count > size - offset) return false;
    offset += (size_t)count;
  }
  if (!active(op) || !file_current(op->owner, role)) return false;
  op->changed = true;
  if (ftruncate(op->owner->files[role], (off_t)size) || !active(op) || !file_current(op->owner, role)) return false;
  return true;
}
static bool sync_file(operation *op, unsigned role) {
  if (!active(op) || !file_current(op->owner, role)) return false;
  /* A failed idempotent durability check cannot clear a previous unknown. */
  op->changed = true;
  return fsync(op->owner->files[role]) == 0 && active(op) && file_current(op->owner, role) &&
    fsync(op->owner->directory) == 0 && active(op) && file_current(op->owner, role);
}
static bool exact(operation *op, unsigned role, const unsigned char *bytes, size_t size) {
  unsigned char actual[GENERAL_REGISTRATION_RECORD_MAX]; size_t count;
  return read_file(op, role, actual, &count) && count == size && !memcmp(actual, bytes, size);
}
general_registration_io *general_registration_io_create(int directory) {
  struct stat initial;
  if (!root() || directory < 0 || fstat(directory, &initial) || !protected_entry(&initial, true) || !general_protected_acl_readonly(directory) || atomic_flag_test_and_set(&held)) return NULL;
  general_registration_io *owner = calloc(1, sizeof(*owner)); if (!owner) { atomic_flag_clear(&held); return NULL; }
  owner->directory = -1; owner->files[0] = owner->files[1] = -1;
  owner->directory = fcntl(directory, F_DUPFD_CLOEXEC, 3); owner->identities[0] = initial; owner->known[0] = true;
  if (owner->directory >= 0 && fcntl(owner->directory, F_GETPATH, owner->path) == 0 && directory_current(owner)) return owner;
  if (general_registration_io_close(&owner)) return NULL;
  return owner;
}
bool general_registration_io_inspect(general_registration_io *owner, bool (*current)(void *), void *context, general_registration_view *out) {
  operation op; if (!out || !begin(owner, current, context, &op)) return false;
  general_registration_view view; bool ok = snapshot(&op, &view);
  end(&op, ok); if (ok) *out = view; return ok;
}
general_registration_io_result general_registration_io_reserve(general_registration_io *owner, const general_initialization_plan *plan, bool (*current)(void *), void *context) {
  operation op; if (!general_initialization_plan_valid(plan) || !begin(owner, current, context, &op)) return GENERAL_REGISTRATION_IO_REJECTED;
  general_registration_view view; general_registration_record record = { .identity = plan->identity, .phase = GENERAL_REGISTRATION_RESERVED };
  unsigned char bytes[GENERAL_REGISTRATION_RECORD_MAX]; size_t size = 0; bool wrote = false;
  bool ok = snapshot(&op, &view) && !view.assignment_present;
  if (ok && view.registration_present) ok = general_registration_binding_valid(&view.registration, plan) && view.registration.phase == GENERAL_REGISTRATION_RESERVED;
  else if (ok) { ok = general_registration_record_encode(&record, bytes, sizeof(bytes), &size) && create_file(&op, 0) && write_file(&op, 0, bytes, size); wrote = ok; }
  if (ok) ok = sync_file(&op, 0) && (!wrote || exact(&op, 0, bytes, size)) && snapshot(&op, &view) && general_registration_binding_valid(&view.registration, plan) && view.registration.phase == GENERAL_REGISTRATION_RESERVED && !view.assignment_present;
  return end(&op, ok);
}
general_registration_io_result general_registration_io_advance(general_registration_io *owner, const general_initialization_plan *plan,
  general_registration_phase expected, general_registration_phase next, bool (*current)(void *), void *context) {
  general_registration_record before = {0}, after = {0};
  if (!plan) return GENERAL_REGISTRATION_IO_REJECTED;
  before.identity = after.identity = plan->identity; before.phase = expected; after.phase = next;
  operation op; if (!general_registration_advance_valid(&before, &after, plan) || !begin(owner, current, context, &op)) return GENERAL_REGISTRATION_IO_REJECTED;
  general_registration_view view; unsigned char bytes[GENERAL_REGISTRATION_RECORD_MAX]; size_t size = 0; bool wrote = false;
  bool ok = snapshot(&op, &view) && view.registration_present && general_registration_binding_valid(&view.registration, plan) && view.registration.phase == expected &&
    (!view.assignment_present || assignment_matches(&view.assignment, plan)) && (next != GENERAL_REGISTRATION_ASSIGNED || view.assignment_present) &&
    (expected != GENERAL_REGISTRATION_RESERVED || !view.assignment_present);
  if (ok && next != expected) { ok = general_registration_record_encode(&after, bytes, sizeof(bytes), &size) && write_file(&op, 0, bytes, size); wrote = ok; }
  if (ok) ok = sync_file(&op, 0) && (!wrote || exact(&op, 0, bytes, size)) && snapshot(&op, &view) && general_registration_binding_valid(&view.registration, plan) && view.registration.phase == next &&
    (!view.assignment_present || assignment_matches(&view.assignment, plan));
  return end(&op, ok);
}
general_registration_io_result general_registration_io_assign(general_registration_io *owner, const general_initialization_plan *plan,
  const general_enrollment_payload *payload, bool (*current)(void *), void *context) {
  operation op;
  if (!payload || payload->command != GENERAL_ENROLLMENT_ASSIGN || !general_initialization_plan_valid(plan) ||
      !general_initialization_binding_valid(&payload->body.assign.initialization, plan) || payload->body.assign.initialization.phase != GENERAL_INITIALIZATION_PREPARED ||
      !general_native_head_valid(&payload->body.assign.head) || !general_native_head_same_identity(&payload->body.assign.head, &plan->identity) || !begin(owner, current, context, &op)) return GENERAL_REGISTRATION_IO_REJECTED;
  general_registration_view view; unsigned char bytes[GENERAL_ASSIGNMENT_MAX_BYTES]; size_t size = 0; bool wrote = false;
  bool ok = snapshot(&op, &view) && view.registration_present && general_registration_binding_valid(&view.registration, plan) &&
    (view.registration.phase == GENERAL_REGISTRATION_HEAD_CREATE_STARTED || view.registration.phase == GENERAL_REGISTRATION_ASSIGNED);
  if (ok && view.assignment_present) ok = assignment_matches(&view.assignment, plan);
  else if (ok) {
    general_assignment assignment = { .uid = plan->identity.uid };
    memcpy(assignment.enrollment_id, plan->identity.enrollment_id, sizeof(assignment.enrollment_id)); memcpy(assignment.installation_id, plan->identity.installation_id, sizeof(assignment.installation_id));
    memcpy(assignment.owner_id, plan->identity.owner_id, sizeof(assignment.owner_id)); memcpy(assignment.initialization_id, plan->identity.initialization_id, sizeof(assignment.initialization_id));
    memcpy(assignment.initialization_digest, plan->identity.initialization_digest, sizeof(assignment.initialization_digest));
    ok = view.registration.phase == GENERAL_REGISTRATION_HEAD_CREATE_STARTED && general_encode_assignment(&assignment, bytes, sizeof(bytes), &size) &&
      create_file(&op, 1) && write_file(&op, 1, bytes, size); wrote = ok;
  }
  if (ok) ok = sync_file(&op, 1) && (!wrote || exact(&op, 1, bytes, size)) && snapshot(&op, &view) && view.assignment_present && assignment_matches(&view.assignment, plan) && general_registration_binding_valid(&view.registration, plan);
  return end(&op, ok);
}
bool general_registration_io_close(general_registration_io **pointer) {
  if (!pointer || !*pointer) return true;
  general_registration_io *owner = *pointer;
  if (owner->pending || owner->close_uncertain) return false;
  for (unsigned role = 0; role < 3; role++) {
    int *slot = role == 2 ? &owner->directory : &owner->files[role]; if (*slot < 0) continue;
    unsigned identity = role == 2 ? 0 : role + 1; struct stat actual;
    if (!owner->known[identity] || fstat(*slot, &actual) || !same(&actual, &owner->identities[identity]) || ((actual.st_mode ^ owner->identities[identity].st_mode) & S_IFMT)) owner->close_uncertain = true;
    else { int fd = *slot; *slot = -1; if (close(fd)) owner->close_uncertain = true; }
  }
  if (owner->close_uncertain) return false;
  free(owner); *pointer = NULL; atomic_flag_clear(&held); return true;
}
