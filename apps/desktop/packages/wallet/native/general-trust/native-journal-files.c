#include "native-journal-files.h"
#include <errno.h>
#include <fcntl.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static atomic_flag owned = ATOMIC_FLAG_INIT;
static const char *const names[] = { "native-journal.sqlite", "native-journal.sqlite-wal" };
struct general_native_journal_files {
  int directory, descriptors[2];
  struct stat identities[3];
  bool borrowed[2], uncertain, created;
};
static bool role_valid(general_native_file_role role) { return role == GENERAL_NATIVE_FILE_DATABASE || role == GENERAL_NATIVE_FILE_WAL; }
static bool private_entry(const struct stat *entry, bool directory) {
  return geteuid() != 0 && getuid() == geteuid() && entry->st_uid == geteuid() &&
    (entry->st_mode & 07777) == (directory ? 0700 : 0600) &&
    (directory ? S_ISDIR(entry->st_mode) : S_ISREG(entry->st_mode) && entry->st_nlink == 1 && entry->st_size >= 0);
}
static bool same(const struct stat *left, const struct stat *right) { return left->st_dev == right->st_dev && left->st_ino == right->st_ino; }
static void erase(void *value, size_t size) { volatile unsigned char *bytes = value; while (size--) *bytes++ = 0; }
static bool facts(general_native_journal_files *files, uint64_t sizes[2]) {
  if (!files || files->uncertain) return false;
  struct stat directory;
  if (fstat(files->directory, &directory) || !private_entry(&directory, true) || !same(&directory, &files->identities[0])) return false;
  struct stat unexpected;
  if (fstatat(files->directory, "native-journal.sqlite-journal", &unexpected, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) return false;
  for (unsigned i = 0; i < 2; i++) {
    struct stat actual, named;
    if (fstat(files->descriptors[i], &actual) || !private_entry(&actual, false) || !same(&actual, &files->identities[i + 1]) ||
        fstatat(files->directory, names[i], &named, AT_SYMLINK_NOFOLLOW) || !private_entry(&named, false) || !same(&actual, &named) || actual.st_size != named.st_size) return false;
    sizes[i] = (uint64_t)actual.st_size;
  }
  return sizes[0] <= GENERAL_NATIVE_JOURNAL_BYTES && sizes[1] <= GENERAL_NATIVE_JOURNAL_BYTES - sizes[0];
}
general_native_journal_files *general_native_journal_files_open(int directory) {
  struct stat initial;
  if (directory < 0 || fstat(directory, &initial) || !private_entry(&initial, true) || atomic_flag_test_and_set(&owned)) return NULL;
  general_native_journal_files *files = calloc(1, sizeof(*files));
  if (!files) { atomic_flag_clear(&owned); return NULL; }
  files->directory = -1; files->descriptors[0] = files->descriptors[1] = -1; files->identities[0] = initial;
  files->directory = fcntl(directory, F_DUPFD_CLOEXEC, 3);
  if (files->directory >= 0) {
    for (unsigned i = 0; i < 2; i++) {
      files->descriptors[i] = openat(files->directory, names[i], O_RDWR | O_CLOEXEC | O_NONBLOCK | O_NOFOLLOW);
      if (files->descriptors[i] < 0 || fstat(files->descriptors[i], &files->identities[i + 1]) || !private_entry(&files->identities[i + 1], false)) break;
    }
    uint64_t sizes[2];
    if (files->descriptors[0] >= 0 && files->descriptors[1] >= 0 && !same(&files->identities[1], &files->identities[2]) && facts(files, sizes)) return files;
  }
  /* No SQLite IO can have started. Unknown cleanup still reserves this process. */
  int descriptors[] = { files->descriptors[0], files->descriptors[1], files->directory };
  files->directory = files->descriptors[0] = files->descriptors[1] = -1;
  for (unsigned i = 0; i < 3; i++) if (descriptors[i] >= 0 && close(descriptors[i])) files->uncertain = true;
  if (files->uncertain) return files;
  erase(files, sizeof(*files)); free(files);
  atomic_flag_clear(&owned);
  return NULL;
}
bool general_native_journal_files_current(general_native_journal_files *files) { uint64_t sizes[2]; return facts(files, sizes); }
typedef struct { bool (*current)(void *); void *context; struct timespec started, last; } creation;
static bool creation_current(creation *scope) {
  struct timespec now;
  if (!scope->current(scope->context) || clock_gettime(CLOCK_MONOTONIC, &now) || now.tv_sec < scope->last.tv_sec || now.tv_nsec < 0 || now.tv_nsec >= 1000000000 ||
      (now.tv_sec == scope->last.tv_sec && now.tv_nsec < scope->last.tv_nsec) || now.tv_sec < scope->started.tv_sec ||
      now.tv_sec - scope->started.tv_sec > 30 || (now.tv_sec - scope->started.tv_sec == 30 && now.tv_nsec >= scope->started.tv_nsec)) return false;
  scope->last = now; return true;
}
general_native_files_creation general_native_journal_files_create(int directory, bool (*current)(void *), void *context, general_native_journal_files **out) {
  if (directory < 0 || !current || !out || *out) return GENERAL_NATIVE_FILES_REJECTED;
  creation scope = { .current = current, .context = context }; struct stat initial, value;
  if (clock_gettime(CLOCK_MONOTONIC, &scope.started)) return GENERAL_NATIVE_FILES_REJECTED;
  scope.last = scope.started;
  if (!creation_current(&scope) || fstat(directory, &initial) || !private_entry(&initial, true)) return GENERAL_NATIVE_FILES_REJECTED;
  if (atomic_flag_test_and_set(&owned)) return GENERAL_NATIVE_FILES_BUSY;
  general_native_journal_files *files = calloc(1, sizeof(*files));
  if (!files) { atomic_flag_clear(&owned); return GENERAL_NATIVE_FILES_REJECTED; }
  files->directory = files->descriptors[0] = files->descriptors[1] = -1; files->identities[0] = initial;
  files->directory = fcntl(directory, F_DUPFD_CLOEXEC, 3);
  if (files->directory < 0) goto rejected;
  const char *entries[] = { names[0], names[1], "native-journal.sqlite-journal", "native-journal.sqlite-shm" };
  if (!creation_current(&scope) || fstat(files->directory, &value) || !private_entry(&value, true) || !same(&value, &initial)) goto rejected;
  for (unsigned i = 0; i < 4; i++) if (!creation_current(&scope) || fstatat(files->directory, entries[i], &value, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) goto rejected;
  for (unsigned i = 0; i < 2; i++) {
    if (!creation_current(&scope)) { if (i) goto uncertain; goto rejected; }
    files->descriptors[i] = openat(files->directory, names[i], O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0600);
    if (files->descriptors[i] < 0 || fstat(files->descriptors[i], &value) ||
        fchmod(files->descriptors[i], 0600) || fstat(files->descriptors[i], &files->identities[i + 1]) ||
        !same(&value, &files->identities[i + 1]) || !creation_current(&scope) || !private_entry(&files->identities[i + 1], false) ||
        files->identities[i + 1].st_size != 0 || fsync(files->descriptors[i]) || !creation_current(&scope)) goto uncertain;
  }
  uint64_t sizes[2];
  if (fsync(files->directory) || !creation_current(&scope) || !facts(files, sizes) || sizes[0] || sizes[1]) goto uncertain;
  files->created = true; *out = files; return GENERAL_NATIVE_FILES_CREATED;
uncertain:
  files->uncertain = true; *out = files; return GENERAL_NATIVE_FILES_UNCERTAIN;
rejected:
  if (files->directory >= 0) {
    int fd = files->directory; files->directory = -1;
    if (close(fd)) goto uncertain;
  }
  erase(files, sizeof(*files)); free(files); atomic_flag_clear(&owned); return GENERAL_NATIVE_FILES_REJECTED;
}
bool general_native_journal_files_created_empty(general_native_journal_files *files) {
  uint64_t sizes[2]; return files && files->created && facts(files, sizes) && !sizes[0] && !sizes[1];
}
bool general_native_journal_files_sizes(general_native_journal_files *files, uint64_t *database, uint64_t *wal) {
  uint64_t sizes[2]; if (!database || !wal || !facts(files, sizes)) return false;
  *database = sizes[0]; *wal = sizes[1]; return true;
}
bool general_native_journal_files_resize_allowed(general_native_journal_files *files, general_native_file_role role, uint64_t proposed_size) {
  uint64_t sizes[2]; if (!role_valid(role) || !facts(files, sizes) || proposed_size > GENERAL_NATIVE_JOURNAL_BYTES) return false;
  return sizes[1 - (unsigned)role] <= GENERAL_NATIVE_JOURNAL_BYTES - proposed_size;
}
int general_native_journal_files_borrow(general_native_journal_files *files, general_native_file_role role) {
  if (!role_valid(role) || !general_native_journal_files_current(files) || files->borrowed[role]) return -1;
  files->borrowed[role] = true; return files->descriptors[role];
}
bool general_native_journal_files_release(general_native_journal_files *files, general_native_file_role role) {
  if (!files || files->uncertain || !role_valid(role) || !files->borrowed[role]) return false;
  files->borrowed[role] = false; return true;
}
bool general_native_journal_files_close(general_native_journal_files **owner) {
  if (!owner || !*owner) return true;
  general_native_journal_files *files = *owner;
  if (files->uncertain || files->borrowed[0] || files->borrowed[1]) return false;
  int descriptors[] = { files->descriptors[0], files->descriptors[1], files->directory };
  files->directory = files->descriptors[0] = files->descriptors[1] = -1;
  for (unsigned i = 0; i < 3; i++) {
    struct stat actual; const struct stat *expected = &files->identities[i == 2 ? 0 : i + 1];
    if (fstat(descriptors[i], &actual) || !same(&actual, expected) || ((actual.st_mode ^ expected->st_mode) & S_IFMT)) files->uncertain = true;
    else if (close(descriptors[i])) files->uncertain = true;
  }
  if (files->uncertain) return false;
  erase(files, sizeof(*files)); free(files); *owner = NULL; atomic_flag_clear(&owned); return true;
}
