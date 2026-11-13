#include "repository-files.h"
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/acl.h>
#include <time.h>
#include <unistd.h>

static atomic_flag registry_guard = ATOMIC_FLAG_INIT;
static general_repository_files *registry[16];
struct general_repository_files {
  int directory, descriptors[3];
  struct stat identities[4];
  char path[PATH_MAX], names[3][64];
  bool loaned[3], uncertain, revoked, created;
  bool (*current)(void *); void *context;
};
static bool register_owner(general_repository_files *owner) {
  if (atomic_flag_test_and_set(&registry_guard)) return false;
  unsigned slot = 16;
  for (unsigned i = 0; i < 16; i++) {
    if (!registry[i]) { if (slot == 16) slot = i; }
    else if (registry[i]->identities[0].st_dev == owner->identities[0].st_dev &&
        registry[i]->identities[0].st_ino == owner->identities[0].st_ino) { slot = 16; break; }
  }
  if (slot < 16) registry[slot] = owner;
  atomic_flag_clear(&registry_guard); return slot < 16;
}
static bool unregister_owner(general_repository_files *owner) {
  if (atomic_flag_test_and_set(&registry_guard)) return false;
  bool found = false;
  for (unsigned i = 0; i < 16; i++) if (registry[i] == owner) { registry[i] = NULL; found = true; break; }
  atomic_flag_clear(&registry_guard); return found;
}
static bool role_valid(general_repository_role role) { return role >= GENERAL_REPOSITORY_DATABASE && role <= GENERAL_REPOSITORY_WAL; }
static bool no_acl(int fd) {
  errno = 0; acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED); if (!acl) return errno == ENOENT;
  acl_entry_t entry; errno = 0; int count = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry), failure = errno;
  int released = acl_free(acl); return count == -1 && failure == EINVAL && released == 0;
}
static bool private_entry(const struct stat *entry, bool directory) {
  return geteuid() != 0 && getuid() == geteuid() && entry->st_uid == geteuid() &&
    (entry->st_mode & 07777) == (directory ? 0700 : 0600) &&
    (directory ? S_ISDIR(entry->st_mode) : S_ISREG(entry->st_mode) && entry->st_nlink == 1 && entry->st_size >= 0);
}
static bool same(const struct stat *a, const struct stat *b) { return a->st_dev == b->st_dev && a->st_ino == b->st_ino; }
static bool absent(int directory, const char *name) { struct stat entry; return fstatat(directory, name, &entry, AT_SYMLINK_NOFOLLOW) < 0 && errno == ENOENT; }
static bool parent(general_repository_files *owner) {
  struct stat actual, named; char path[PATH_MAX];
  return fstat(owner->directory, &actual) == 0 && private_entry(&actual, true) && same(&actual, &owner->identities[0]) && no_acl(owner->directory) &&
    fcntl(owner->directory, F_GETPATH, path) == 0 && !strcmp(path, owner->path) && lstat(path, &named) == 0 && private_entry(&named, true) && same(&actual, &named);
}
static bool sidecars(general_repository_files *owner) {
  char name[96];
  for (unsigned i = 0; i < 2; i++) for (unsigned j = 0; j < (i ? 3U : 2U); j++) {
    const char *suffix = j == 0 ? "-journal" : j == 1 ? "-shm" : "-wal";
    int size = snprintf(name, sizeof(name), "%s%s", owner->names[i], suffix);
    if (size < 1 || size >= (int)sizeof(name) || !absent(owner->directory, name)) return false;
  }
  return true;
}
static bool facts(general_repository_files *owner, uint64_t sizes[3]) {
  if (!owner || owner->uncertain || owner->revoked || !owner->current(owner->context) || !parent(owner) || !sidecars(owner)) return false;
  uint64_t total = 0;
  for (unsigned i = 0; i < 3; i++) {
    struct stat actual, named;
    if (fstat(owner->descriptors[i], &actual) || !private_entry(&actual, false) || !same(&actual, &owner->identities[i + 1]) || !no_acl(owner->descriptors[i]) ||
        fstatat(owner->directory, owner->names[i], &named, AT_SYMLINK_NOFOLLOW) || !private_entry(&named, false) || !same(&actual, &named) || actual.st_size != named.st_size ||
        fcntl(owner->descriptors[i], F_GETFD) < 0 || !(fcntl(owner->descriptors[i], F_GETFD) & FD_CLOEXEC) ||
        (fcntl(owner->descriptors[i], F_GETFL) & O_ACCMODE) != O_RDWR) return false;
    sizes[i] = (uint64_t)actual.st_size;
    if (sizes[i] > GENERAL_REPOSITORY_BYTES - total) return false;
    total += sizes[i];
  }
  return owner->current(owner->context);
}
static void erase(void *value, size_t size) { volatile unsigned char *bytes = value; while (size--) *bytes++ = 0; }
static bool fresh_file(general_repository_files *owner, unsigned role) {
  int fd = openat(owner->directory, owner->names[role], O_CREAT | O_EXCL | O_RDWR | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK, 0600);
  if (fd < 0) return false;
  owner->descriptors[role] = fd; struct stat initial;
  if (fstat(fd, &initial) || !S_ISREG(initial.st_mode) || initial.st_uid != geteuid() || initial.st_nlink != 1 || initial.st_size) return false;
  acl_t empty = acl_init(0); if (!empty) return false;
  int changed = acl_set_fd_np(fd, empty, ACL_TYPE_EXTENDED), released = acl_free(empty);
  return changed == 0 && released == 0 && fchmod(fd, 0600) == 0 && fstat(fd, &owner->identities[role + 1]) == 0 &&
    same(&initial, &owner->identities[role + 1]) && private_entry(&owner->identities[role + 1], false) && no_acl(fd) && fsync(fd) == 0;
}
typedef struct { bool (*current)(void *); void *context; struct timespec start, last; } construction;
static bool active(construction *op) {
  struct timespec now;
  if (!op->current(op->context) || clock_gettime(CLOCK_MONOTONIC, &now) || now.tv_sec < 0 || now.tv_nsec < 0 || now.tv_nsec >= 1000000000 ||
      now.tv_sec < op->last.tv_sec || (now.tv_sec == op->last.tv_sec && now.tv_nsec < op->last.tv_nsec)) return false;
  op->last = now; return now.tv_sec - op->start.tv_sec < 30 || (now.tv_sec - op->start.tv_sec == 30 && now.tv_nsec < op->start.tv_nsec);
}
general_repository_open_result general_repository_files_open(int directory, general_repository_kind kind, bool create,
    bool (*current)(void *), void *context, general_repository_files **out) {
  if (directory < 0 || kind < GENERAL_REPOSITORY_STATE || kind > GENERAL_REPOSITORY_SIGNING || !current || !out || *out) return GENERAL_REPOSITORY_REJECTED;
  construction op = { .current = current, .context = context }; struct stat initial;
  if (clock_gettime(CLOCK_MONOTONIC, &op.start) || op.start.tv_sec < 0 || op.start.tv_nsec < 0 || op.start.tv_nsec >= 1000000000) return GENERAL_REPOSITORY_REJECTED;
  op.last = op.start;
  if (!active(&op) || fstat(directory, &initial) || !private_entry(&initial, true) || !no_acl(directory)) return GENERAL_REPOSITORY_REJECTED;
  general_repository_files *owner = calloc(1, sizeof(*owner));
  if (!owner) return GENERAL_REPOSITORY_REJECTED;
  owner->directory = -1; for (unsigned i = 0; i < 3; i++) owner->descriptors[i] = -1;
  owner->current = current; owner->context = context; owner->identities[0] = initial;
  if (!register_owner(owner)) { free(owner); return GENERAL_REPOSITORY_REJECTED; }
  strcpy(owner->names[0], kind == GENERAL_REPOSITORY_STATE ? "general-wallet.sqlite" : "general-signing-journal.sqlite");
  strcpy(owner->names[1], "writer-lease.sqlite");
  if (snprintf(owner->names[2], sizeof(owner->names[2]), "%s-wal", owner->names[0]) < 1) goto rejected;
  owner->directory = fcntl(directory, F_DUPFD_CLOEXEC, 3);
  if (owner->directory < 0 || fcntl(owner->directory, F_GETPATH, owner->path) || !active(&op) || !parent(owner) || !sidecars(owner)) goto rejected;
  if (create) for (unsigned i = 0; i < 3; i++) if (!absent(owner->directory, owner->names[i])) goto rejected;
  for (unsigned i = 0; i < 3; i++) {
    if (!active(&op) || !parent(owner)) goto rejected_or_uncertain;
    if (create || (i == 2 && absent(owner->directory, owner->names[i]))) {
      if (!fresh_file(owner, i)) goto uncertain;
    } else {
      owner->descriptors[i] = openat(owner->directory, owner->names[i], O_RDWR | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
      if (owner->descriptors[i] < 0 || fstat(owner->descriptors[i], &owner->identities[i + 1]) || !private_entry(&owner->identities[i + 1], false) || !no_acl(owner->descriptors[i])) goto rejected_or_uncertain;
    }
    for (unsigned j = 0; j < i; j++) if (same(&owner->identities[j + 1], &owner->identities[i + 1])) goto rejected_or_uncertain;
  }
  uint64_t sizes[3];
  if (!active(&op) || !facts(owner, sizes) || fsync(owner->directory) || !active(&op)) goto uncertain;
  owner->created = create; *out = owner; return GENERAL_REPOSITORY_READY;
rejected_or_uncertain:
  if (create && owner->descriptors[0] >= 0) goto uncertain;
rejected:
  for (unsigned i = 0; i < 3; i++) if (owner->descriptors[i] >= 0) { int fd = owner->descriptors[i]; owner->descriptors[i] = -1; if (close(fd)) goto uncertain; }
  if (owner->directory >= 0) { int fd = owner->directory; owner->directory = -1; if (close(fd)) goto uncertain; }
  if (!unregister_owner(owner)) goto uncertain;
  erase(owner, sizeof(*owner)); free(owner); return GENERAL_REPOSITORY_REJECTED;
uncertain:
  owner->uncertain = true; *out = owner; return GENERAL_REPOSITORY_UNCERTAIN;
}
bool general_repository_files_created_empty(general_repository_files *owner) {
  uint64_t sizes[3]; return owner && owner->created && general_repository_files_sizes(owner, sizes) && !sizes[0] && !sizes[1] && !sizes[2];
}
bool general_repository_files_current(general_repository_files *owner) {
  uint64_t sizes[3]; bool valid = facts(owner, sizes); if (owner && !valid) owner->revoked = true; return valid;
}
bool general_repository_files_sizes(general_repository_files *owner, uint64_t sizes[3]) {
  uint64_t values[3]; if (!sizes) return false;
  if (!facts(owner, values)) { if (owner) owner->revoked = true; return false; }
  memcpy(sizes, values, sizeof(values)); return true;
}
bool general_repository_files_resize_allowed(general_repository_files *owner, general_repository_role role, uint64_t size) {
  uint64_t sizes[3]; if (!role_valid(role) || size > GENERAL_REPOSITORY_BYTES || !general_repository_files_sizes(owner, sizes)) return false;
  uint64_t total = size; for (unsigned i = 0; i < 3; i++) if (i != (unsigned)role) { if (sizes[i] > GENERAL_REPOSITORY_BYTES - total) return false; total += sizes[i]; }
  return true;
}
int general_repository_files_borrow(general_repository_files *owner, general_repository_role role) {
  if (!role_valid(role) || !general_repository_files_current(owner) || owner->loaned[role]) return -1;
  owner->loaned[role] = true; return owner->descriptors[role];
}
bool general_repository_files_return(general_repository_files *owner, general_repository_role role) {
  if (!owner || !role_valid(role) || !owner->loaned[role]) return false; owner->loaned[role] = false; return true;
}
bool general_repository_files_identity(general_repository_files *owner, general_repository_role role, struct stat *out) {
  if (!out || !role_valid(role) || !general_repository_files_current(owner)) return false; *out = owner->identities[(unsigned)role + 1]; return true;
}
bool general_repository_files_close(general_repository_files **value) {
  if (!value || !*value) return true; general_repository_files *owner = *value;
  if (owner->uncertain || owner->loaned[0] || owner->loaned[1] || owner->loaned[2]) return false;
  int descriptors[] = { owner->descriptors[0], owner->descriptors[1], owner->descriptors[2], owner->directory };
  for (unsigned i = 0; i < 4; i++) {
    struct stat actual; unsigned identity = i == 3 ? 0 : i + 1;
    if (descriptors[i] < 0 || fstat(descriptors[i], &actual) || !same(&actual, &owner->identities[identity]) || ((actual.st_mode ^ owner->identities[identity].st_mode) & S_IFMT)) {
      owner->uncertain = true; return false;
    }
  }
  owner->uncertain = true;
  for (unsigned i = 0; i < 4; i++) if (close(descriptors[i])) return false;
  if (!unregister_owner(owner)) return false;
  erase(owner, sizeof(*owner)); free(owner); *value = NULL; return true;
}
