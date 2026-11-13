#include "session-lock.h"
#include "protected-acl.h"
#include <fcntl.h>
#include <limits.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static atomic_flag occupied = ATOMIC_FLAG_INIT;
static const char *const names[] = { "installation.lock", "owner.lock" };
struct general_session_locks {
  int directories[2], files[2];
  struct stat directory_ids[2], file_ids[2];
  char paths[2][PATH_MAX];
  uid_t uid;
  int inspection_directory; bool inspection, inspection_known, inspection_acquired;
  bool enrollment, known_directories[2], known_files[2], acquired[2], ready, loan, uncertain;
};
typedef struct { bool (*current)(void *); void *context; struct timespec started, last; } lifetime;
static bool active(lifetime *life) {
  struct timespec now;
  if (!life->current(life->context) || clock_gettime(CLOCK_MONOTONIC, &now) || now.tv_nsec < 0 || now.tv_nsec >= 1000000000 ||
      now.tv_sec < life->last.tv_sec || (now.tv_sec == life->last.tv_sec && now.tv_nsec < life->last.tv_nsec)) return false;
  life->last = now;
  time_t seconds = now.tv_sec - life->started.tv_sec;
  return seconds >= 0 && (seconds < 30 || (seconds == 30 && now.tv_nsec < life->started.tv_nsec));
}
static bool same(const struct stat *left, const struct stat *right) { return left->st_dev == right->st_dev && left->st_ino == right->st_ino; }
static bool protected(const struct stat *value, bool directory) {
  return value->st_uid == 0 && !(value->st_mode & 07022) && (directory ? S_ISDIR(value->st_mode) && value->st_nlink > 0 : S_ISREG(value->st_mode) && value->st_nlink == 1);
}
static bool cloexec(int fd) { int flags = fcntl(fd, F_GETFD); return flags >= 0 && (flags & FD_CLOEXEC); }
static bool role(general_session_locks *owner) {
  return getuid() == owner->uid && geteuid() == owner->uid && (owner->enrollment ? owner->uid == 0 : owner->uid > 0 && owner->uid < UINT32_MAX);
}
static bool directory_current(general_session_locks *owner, unsigned index) {
  struct stat value; char path[PATH_MAX];
  return owner->known_directories[index] && fstat(owner->directories[index], &value) == 0 && protected(&value, true) && same(&value, &owner->directory_ids[index]) &&
    cloexec(owner->directories[index]) && fcntl(owner->directories[index], F_GETPATH, path) == 0 && !strcmp(path, owner->paths[index]) && general_protected_acl_readonly(owner->directories[index]);
}
static bool file_current(general_session_locks *owner, unsigned index) {
  struct stat value, named;
  return directory_current(owner, index) && owner->known_files[index] && fstat(owner->files[index], &value) == 0 && protected(&value, false) && same(&value, &owner->file_ids[index]) &&
    fstatat(owner->directories[index], names[index], &named, AT_SYMLINK_NOFOLLOW) == 0 && protected(&named, false) && same(&value, &named) &&
    cloexec(owner->files[index]) && general_protected_acl_readonly(owner->files[index]);
}
static bool lock_shape(int fd, bool exclusive) {
  struct flock value = { .l_type = F_WRLCK, .l_whence = SEEK_SET, .l_start = 0, .l_len = 0, .l_pid = -1 };
  return fcntl(fd, F_OFD_GETLK, &value) == 0 && value.l_type == (exclusive ? F_WRLCK : F_RDLCK) && value.l_whence == SEEK_SET && value.l_start == 0 && value.l_len == 0 && value.l_pid == -1;
}
static bool inspection_current(general_session_locks *owner) {
  struct stat actual;
  return !owner->inspection || (owner->inspection_known && owner->inspection_acquired &&
    !fstat(owner->inspection_directory, &actual) && protected(&actual, true) && same(&actual, &owner->directory_ids[1]) &&
    cloexec(owner->inspection_directory) && general_protected_acl_readonly(owner->inspection_directory) && lock_shape(owner->inspection_directory, false));
}
bool general_session_locks_installation_current(general_session_locks *owner) {
  return owner && owner->ready && !owner->uncertain && role(owner) && owner->acquired[0] && file_current(owner, 0) && lock_shape(owner->files[0], false);
}
bool general_session_locks_current(general_session_locks *owner) {
  return owner && owner->ready && !owner->uncertain && role(owner) && file_current(owner, 0) && file_current(owner, 1) &&
    owner->acquired[0] && owner->acquired[1] && lock_shape(owner->files[0], false) && lock_shape(owner->files[1], true) && inspection_current(owner);
}
static general_session_lock_result acquire(int fd, int kind) {
  if (!flock(fd, kind | LOCK_NB)) return GENERAL_SESSION_LOCK_READY;
  return errno == EAGAIN || errno == EWOULDBLOCK ? GENERAL_SESSION_LOCK_BUSY : GENERAL_SESSION_LOCK_INVALID;
}
static general_session_lock_result open_locks(int installation, int user, int *received, bool enrollment, bool installation_only, bool inspection, bool (*current)(void *), void *context, general_session_locks **out) {
  uid_t uid = getuid();
  if (!out || *out || !current || geteuid() != uid || (enrollment ? uid != 0 || (!installation_only && (!received || *received < 0)) : uid == 0 || uid == UINT32_MAX)) return GENERAL_SESSION_LOCK_INVALID;
  lifetime life = { .current = current, .context = context };
  if (clock_gettime(CLOCK_MONOTONIC, &life.started)) return GENERAL_SESSION_LOCK_INVALID;
  life.last = life.started;
  struct stat ids[2]; int inputs[] = { installation, user };
  for (unsigned i = 0; i < (installation_only ? 1U : 2U); i++) if (!active(&life) || inputs[i] < 0 || fstat(inputs[i], &ids[i]) || !protected(&ids[i], true) || !general_protected_acl_readonly(inputs[i])) return GENERAL_SESSION_LOCK_INVALID;
  if (!installation_only && same(&ids[0], &ids[1])) return GENERAL_SESSION_LOCK_INVALID;
  if (atomic_flag_test_and_set(&occupied)) return GENERAL_SESSION_LOCK_BUSY;
  general_session_locks *owner = calloc(1, sizeof(*owner));
  if (!owner) { atomic_flag_clear(&occupied); return GENERAL_SESSION_LOCK_INVALID; }
  owner->directories[0] = owner->directories[1] = owner->files[0] = owner->files[1] = -1; owner->enrollment = enrollment; owner->uid = uid;
  owner->inspection_directory = -1; owner->inspection = inspection;
  general_session_lock_result result = GENERAL_SESSION_LOCK_INVALID;
  for (unsigned i = 0; i < (installation_only ? 1U : 2U); i++) {
    owner->directories[i] = fcntl(inputs[i], F_DUPFD_CLOEXEC, 3); owner->directory_ids[i] = ids[i]; owner->known_directories[i] = true;
    if (owner->directories[i] < 0 || !active(&life) || fcntl(owner->directories[i], F_GETPATH, owner->paths[i]) || !directory_current(owner, i)) goto fail;
  }
  for (unsigned i = 0; i < (installation_only ? 1U : 2U); i++) {
    if (!active(&life) || !role(owner)) goto fail;
    if (i == 1 && enrollment) { owner->files[i] = *received; *received = -1; }
    else owner->files[i] = openat(owner->directories[i], names[i], O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (owner->files[i] < 0) goto fail;
    if (fstat(owner->files[i], &owner->file_ids[i])) { owner->uncertain = true; goto fail; }
    owner->known_files[i] = true;
    if (!file_current(owner, i) || !active(&life)) goto fail;
    if (i == 1 && enrollment && !lock_shape(owner->files[i], true)) goto fail;
    result = acquire(owner->files[i], i ? LOCK_EX : LOCK_SH);
    if (result != GENERAL_SESSION_LOCK_READY) goto fail;
    owner->acquired[i] = true; result = GENERAL_SESSION_LOCK_INVALID;
    if (!active(&life) || !file_current(owner, i)) goto fail;
    if (i == 0 && inspection) {
      owner->inspection_directory = openat(owner->directories[1], ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
      if (owner->inspection_directory < 0) goto fail;
      struct stat value;
      if (fstat(owner->inspection_directory, &value)) { owner->uncertain = true; goto fail; }
      owner->inspection_known = true;
      if (!protected(&value, true) || !same(&value, &owner->directory_ids[1]) || !cloexec(owner->inspection_directory) || !general_protected_acl_readonly(owner->inspection_directory)) goto fail;
      result = acquire(owner->inspection_directory, LOCK_SH);
      if (result != GENERAL_SESSION_LOCK_READY) goto fail;
      owner->inspection_acquired = true; result = GENERAL_SESSION_LOCK_INVALID;
      if (!inspection_current(owner) || !active(&life)) goto fail;
    }
  }
  owner->ready = true;
  if (!(installation_only ? general_session_locks_installation_current(owner) : general_session_locks_current(owner)) || !active(&life)) goto fail;
  *out = owner; return GENERAL_SESSION_LOCK_READY;
fail:
  owner->ready = false;
  if (!general_session_locks_close(&owner)) { *out = owner; return GENERAL_SESSION_LOCK_UNCERTAIN; }
  return result;
}
general_session_lock_result general_session_locks_broker_open(int installation, int user, bool (*current)(void *), void *context, general_session_locks **out) {
  return open_locks(installation, user, NULL, false, false, false, current, context, out);
}
general_session_lock_result general_session_locks_broker_inspection_open(int installation, int user, bool (*current)(void *), void *context, general_session_locks **out) {
  return open_locks(installation, user, NULL, false, false, true, current, context, out);
}
general_session_lock_result general_session_locks_enrollment_open(int installation, int user, int *received, bool (*current)(void *), void *context, general_session_locks **out) {
  if (!received) return GENERAL_SESSION_LOCK_INVALID;
  return open_locks(installation, user, received, true, false, false, current, context, out);
}
general_session_lock_result general_session_locks_enrollment_begin(int installation, bool (*current)(void *), void *context, general_session_locks **out) {
  return open_locks(installation, -1, NULL, true, true, false, current, context, out);
}
general_session_lock_result general_session_locks_enrollment_adopt(general_session_locks *owner, int user, int *received, bool (*current)(void *), void *context) {
  if (!owner || !owner->enrollment || !current || !received || *received < 0 || owner->directories[1] >= 0 || owner->files[1] >= 0 ||
      !general_session_locks_installation_current(owner)) return GENERAL_SESSION_LOCK_INVALID;
  lifetime life = { .current = current, .context = context };
  if (clock_gettime(CLOCK_MONOTONIC, &life.started)) return GENERAL_SESSION_LOCK_INVALID;
  life.last = life.started; struct stat identity;
  if (!active(&life) || user < 0 || fstat(user, &identity) || !protected(&identity, true) ||
      same(&identity, &owner->directory_ids[0]) || !general_protected_acl_readonly(user)) return GENERAL_SESSION_LOCK_INVALID;
  owner->directories[1] = fcntl(user, F_DUPFD_CLOEXEC, 3); owner->directory_ids[1] = identity; owner->known_directories[1] = true;
  general_session_lock_result result = GENERAL_SESSION_LOCK_INVALID;
  if (owner->directories[1] < 0 || !active(&life) || fcntl(owner->directories[1], F_GETPATH, owner->paths[1]) || !directory_current(owner, 1)) goto fail;
  owner->files[1] = *received; *received = -1;
  if (fstat(owner->files[1], &owner->file_ids[1])) { owner->uncertain = true; goto fail; }
  owner->known_files[1] = true;
  if (!active(&life) || !file_current(owner, 1) || !lock_shape(owner->files[1], true)) goto fail;
  result = acquire(owner->files[1], LOCK_EX);
  if (result != GENERAL_SESSION_LOCK_READY) goto fail;
  owner->acquired[1] = true; result = GENERAL_SESSION_LOCK_INVALID;
  if (!general_session_locks_current(owner) || !active(&life)) goto fail;
  return GENERAL_SESSION_LOCK_READY;
fail:
  owner->ready = false;
  return owner->uncertain ? GENERAL_SESSION_LOCK_UNCERTAIN : result;
}
int general_session_locks_borrow_owner(general_session_locks *owner) {
  if (!general_session_locks_current(owner) || owner->enrollment || owner->inspection || owner->loan) return -1;
  owner->loan = true; return owner->files[1];
}
bool general_session_locks_return_owner(general_session_locks *owner) {
  if (!owner || !owner->loan || owner->uncertain) return false;
  owner->loan = false; return true;
}
static bool close_user(general_session_locks *owner) {
  int *slots[] = { &owner->files[1], &owner->directories[1], &owner->inspection_directory };
  for (unsigned i = 0; i < 3; i++) if (*slots[i] >= 0) {
    struct stat actual; const struct stat *expected = i ? &owner->directory_ids[1] : &owner->file_ids[1];
    bool known = i == 0 ? owner->known_files[1] : i == 1 ? owner->known_directories[1] : owner->inspection_known;
    if (!known || fstat(*slots[i], &actual) || !same(&actual, expected) || ((actual.st_mode ^ expected->st_mode) & S_IFMT)) { owner->uncertain = true; return false; }
    int fd = *slots[i]; *slots[i] = -1;
    if (close(fd)) { owner->uncertain = true; return false; }
  }
  owner->acquired[1] = false; return true;
}
bool general_session_locks_release_user(general_session_locks *owner) {
  if (!owner || !owner->ready || owner->enrollment || owner->loan || owner->uncertain) return false;
  return close_user(owner);
}
bool general_session_locks_close(general_session_locks **pointer) {
  if (!pointer || !*pointer) return true;
  general_session_locks *owner = *pointer;
  if (owner->loan || owner->uncertain) return false;
  owner->ready = false;
  if (!close_user(owner)) return false;
  /* Keep the installation guard until every other reference is known closed.
   * Stop on the first unknown; never release still-known guards afterward. */
  const unsigned order[] = { 2, 0 };
  for (unsigned step = 0; step < 2; step++) {
    unsigned role = order[step], index = role % 2; int *slot = role < 2 ? &owner->files[index] : &owner->directories[index]; if (*slot < 0) continue;
    struct stat value; const struct stat *identity = role < 2 ? &owner->file_ids[index] : &owner->directory_ids[index];
    bool known = role < 2 ? owner->known_files[index] : owner->known_directories[index];
    if (!known || fstat(*slot, &value) || !same(&value, identity) || ((value.st_mode ^ identity->st_mode) & S_IFMT)) { owner->uncertain = true; return false; }
    int fd = *slot; *slot = -1;
    if (close(fd)) { owner->uncertain = true; return false; }
  }
  if (owner->uncertain) return false;
  free(owner); *pointer = NULL; atomic_flag_clear(&occupied); return true;
}
