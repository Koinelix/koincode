#include "backup-file.h"
#include <CommonCrypto/CommonDigest.h>
#include <CoreFoundation/CoreFoundation.h>
#include <sys/acl.h>
#include <sys/stat.h>
#include <stdatomic.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <dirent.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define CHUNK 65536U
#define MAX_IO_CALLS 4096U
struct general_backup_target {
  int directory;
  dev_t device;
  ino_t inode;
  char directory_path[PATH_MAX];
  char name[NAME_MAX + 1];
  bool archive;
  int read_file;
  struct stat read_identity;
  size_t read_size;
  unsigned char read_digest[32];
  atomic_bool consumed;
  atomic_bool revoked;
  atomic_bool read_ready;
};

static bool same_directory(const general_backup_target *target) {
  struct stat info;
  char path[PATH_MAX];
  return fstat(target->directory, &info) == 0 && S_ISDIR(info.st_mode) && info.st_nlink > 0 &&
    info.st_dev == target->device && info.st_ino == target->inode && fcntl(target->directory, F_GETPATH, path) == 0 &&
    strcmp(path, target->directory_path) == 0;
}
static bool empty_acl(int file) {
  errno = 0;
  acl_t acl = acl_get_fd_np(file, ACL_TYPE_EXTENDED);
  /* On Darwin a valid fd with no extended ACL returns ENOENT, not an empty acl_t. */
  if (!acl) return errno == ENOENT;
  acl_entry_t entry;
  errno = 0;
  /* A retrieved ACL with no first entry uses EINVAL on Darwin. Other retrieval failures stay failures. */
  bool ok = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry) == -1 && errno == EINVAL;
  acl_free(acl); return ok;
}
static bool archive_id(const unsigned char *value, size_t length) {
  if (!value || length != 36) return false;
  for (size_t index = 0; index < 36; index++) {
    bool dash = index == 8 || index == 13 || index == 18 || index == 23;
    if (dash ? value[index] != '-' : !((value[index] >= '0' && value[index] <= '9') || (value[index] >= 'a' && value[index] <= 'f'))) return false;
  }
  return true;
}
static bool archive_directory(general_backup_target *target, unsigned int maximum) {
  struct stat info;
  if (getuid() == 0 || geteuid() != getuid() || fstat(target->directory, &info) != 0 || info.st_uid != geteuid() ||
      (info.st_mode & 07777) != 0700 || !empty_acl(target->directory)) return false;
  /* A fresh file description avoids sharing readdir's offset with the held directory or a previous scan. */
  int descriptor = openat(target->directory, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0) return false;
  struct stat held;
  if (fstat(descriptor, &held) != 0 || held.st_dev != target->device || held.st_ino != target->inode) { close(descriptor); return false; }
  DIR *directory = fdopendir(descriptor);
  if (!directory) { close(descriptor); return false; }
  bool ok = false; unsigned int count = 0;
  for (unsigned int calls = 0; calls < 12; calls++) {
    errno = 0; struct dirent *entry = readdir(directory);
    if (!entry) { ok = errno == 0; break; }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    size_t length = strnlen(entry->d_name, NAME_MAX + 1);
    if (length != 40 || !archive_id((const unsigned char *)entry->d_name, 36) || memcmp(entry->d_name + 36, ".jwe", 4) != 0 ||
        ++count > maximum || fstatat(target->directory, entry->d_name, &held, AT_SYMLINK_NOFOLLOW) != 0 ||
        !S_ISREG(held.st_mode) || held.st_nlink != 1 || held.st_uid != geteuid() || (held.st_mode & 07777) != 0600 ||
        held.st_size < 0 || (uint64_t)held.st_size > GENERAL_BACKUP_FILE_MAX_BYTES) break;
  }
  if (closedir(directory) != 0) ok = false;
  return ok;
}
static bool current(general_backup_target *target, bool (*live)(void *), void *context) {
  return !atomic_load(&target->revoked) && live(context) && !atomic_load(&target->revoked) && same_directory(target) &&
    (!target->archive || (archive_directory(target, 8) && same_directory(target) && !atomic_load(&target->revoked)));
}
static bool same_file(general_backup_target *target, int file, const struct stat *original, size_t expected_size) {
  struct stat held, named;
  if (fstat(file, &held) != 0 || fstatat(target->directory, target->name, &named, AT_SYMLINK_NOFOLLOW) != 0) return false;
  return S_ISREG(held.st_mode) && S_ISREG(named.st_mode) && held.st_dev == original->st_dev && held.st_ino == original->st_ino &&
    named.st_dev == original->st_dev && named.st_ino == original->st_ino && held.st_nlink == 1 && named.st_nlink == 1 &&
    held.st_uid == geteuid() && named.st_uid == geteuid() && (held.st_mode & 07777) == 0600 && (named.st_mode & 07777) == 0600 &&
    held.st_size >= 0 && named.st_size >= 0 && (uint64_t)held.st_size == expected_size && (uint64_t)named.st_size == expected_size && empty_acl(file);
}
static bool private_acl(int file) {
  acl_t acl = acl_init(0);
  if (!acl) return false;
  bool ok = acl_set_fd_np(file, acl, ACL_TYPE_EXTENDED) == 0;
  acl_free(acl);
  return ok && empty_acl(file);
}

static general_backup_target *create_target(int directory_fd, const unsigned char *name, size_t length, bool archive) {
  if (!name || length == 0 || length > NAME_MAX || memchr(name, 0, length) || memchr(name, '/', length)) return NULL;
  CFStringRef text = CFStringCreateWithBytes(NULL, name, (CFIndex)length, kCFStringEncodingUTF8, false);
  if (!text) return NULL;
  CFRelease(text);
  struct stat info;
  int owned = fcntl(directory_fd, F_DUPFD_CLOEXEC, 0);
  if (owned < 0) return NULL;
  if (fstat(owned, &info) != 0 || !S_ISDIR(info.st_mode) || info.st_nlink == 0) { close(owned); return NULL; }
  general_backup_target *target = calloc(1, sizeof(*target));
  if (!target) { close(owned); return NULL; }
  target->directory = owned; target->device = info.st_dev; target->inode = info.st_ino; target->archive = archive; target->read_file = -1;
  if (fcntl(owned, F_GETPATH, target->directory_path) != 0) { close(owned); free(target); return NULL; }
  memcpy(target->name, name, length); target->name[length] = 0;
  atomic_init(&target->consumed, false); atomic_init(&target->revoked, false);
  atomic_init(&target->read_ready, false);
  if (archive && (!archive_directory(target, 8) || !same_directory(target))) { close(owned); free(target); return NULL; }
  return target;
}
general_backup_target *general_backup_target_create(int directory_fd, const unsigned char *name, size_t length) {
  const char suffix[] = ".koin-general-wallet";
  if (!name || length < sizeof(suffix) - 1 || length > NAME_MAX ||
      memcmp(name + length - (sizeof(suffix) - 1), suffix, sizeof(suffix) - 1) != 0) return NULL;
  return create_target(directory_fd, name, length, false);
}
general_backup_target *general_history_archive_target_create(int directory_fd, const unsigned char *artifact_id, size_t length) {
  if (!archive_id(artifact_id, length)) return NULL;
  unsigned char name[40]; memcpy(name, artifact_id, 36); memcpy(name + 36, ".jwe", 4);
  return create_target(directory_fd, name, sizeof(name), true);
}
void general_backup_target_revoke(general_backup_target *target) { if (target) atomic_store(&target->revoked, true); }
void general_backup_target_destroy(general_backup_target *target) {
  if (!target) return;
  general_backup_target_revoke(target);
  if (target->read_file >= 0) close(target->read_file);
  close(target->directory); free(target);
}

static bool write_all(general_backup_target *target, int file, const struct stat *original,
    const unsigned char *bytes, size_t size, bool (*live)(void *), void *context) {
  size_t offset = 0;
  for (unsigned int calls = 0, interrupts = 0; offset < size && calls < MAX_IO_CALLS; calls++) {
    if (!current(target, live, context) || !same_file(target, file, original, offset)) return false;
    size_t remaining = size - offset, count = remaining < CHUNK ? remaining : CHUNK;
    ssize_t written = write(file, bytes + offset, count);
    if (written < 0 && errno == EINTR && ++interrupts <= 32) continue;
    if (written <= 0 || (size_t)written > count) return false;
    offset += (size_t)written;
    if (!current(target, live, context) || !same_file(target, file, original, offset)) return false;
  }
  return offset == size;
}
static bool readback(general_backup_target *target, int file, const struct stat *original, size_t size,
    const unsigned char expected[32], unsigned char *copy, unsigned char *actual_digest, bool (*live)(void *), void *context) {
  unsigned char buffer[CHUNK], actual[32];
  CC_SHA256_CTX hash; CC_SHA256_Init(&hash);
  size_t offset = 0;
  for (unsigned int calls = 0, interrupts = 0; offset < size && calls < MAX_IO_CALLS; calls++) {
    if (!current(target, live, context) || !same_file(target, file, original, size)) return false;
    size_t remaining = size - offset, count = remaining < CHUNK ? remaining : CHUNK;
    ssize_t received = pread(file, buffer, count, (off_t)offset);
    if (received < 0 && errno == EINTR && ++interrupts <= 32) continue;
    if (received <= 0 || (size_t)received > count) return false;
    CC_SHA256_Update(&hash, buffer, (CC_LONG)received);
    if (copy) memcpy(copy + offset, buffer, (size_t)received);
    offset += (size_t)received;
  }
  CC_SHA256_Final(actual, &hash);
  bool ok = offset == size && (!expected || memcmp(actual, expected, 32) == 0) && current(target, live, context) && same_file(target, file, original, size);
  if (ok && actual_digest) memcpy(actual_digest, actual, 32);
  return ok;
}

general_backup_file_result general_backup_target_publish(general_backup_target *target,
    const unsigned char *ciphertext, size_t size, const unsigned char expected_digest[32],
    bool (*is_current)(void *context), void *context) {
  if (!target || atomic_exchange(&target->consumed, true)) return GENERAL_BACKUP_FILE_UNAVAILABLE;
  if (!ciphertext || !expected_digest || !is_current || size == 0 || size > GENERAL_BACKUP_FILE_MAX_BYTES) return GENERAL_BACKUP_FILE_NOT_CREATED;
  unsigned char expected[32], actual[32]; memcpy(expected, expected_digest, sizeof(expected));
  if (!current(target, is_current, context)) return GENERAL_BACKUP_FILE_NOT_CREATED;
  unsigned char *copy = malloc(size);
  if (!copy) return GENERAL_BACKUP_FILE_NOT_CREATED;
  memcpy(copy, ciphertext, size); CC_SHA256(copy, (CC_LONG)size, actual);
  general_backup_file_result result = GENERAL_BACKUP_FILE_NOT_CREATED;
  int file = -1;
  if (memcmp(actual, expected, 32) != 0 || !current(target, is_current, context) || (target->archive && !archive_directory(target, 7))) goto done;
  file = openat(target->directory, target->name, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (file < 0) goto done;
  result = GENERAL_BACKUP_FILE_UNCERTAIN;
  struct stat original;
  if (fstat(file, &original) != 0 || !S_ISREG(original.st_mode) || original.st_nlink != 1 || original.st_uid != geteuid() ||
      fchmod(file, 0600) != 0 || !private_acl(file) || !current(target, is_current, context) || !same_file(target, file, &original, 0)) goto done;
  if (!write_all(target, file, &original, copy, size, is_current, context) || !current(target, is_current, context) || fsync(file) != 0 ||
      !readback(target, file, &original, size, expected, NULL, NULL, is_current, context) || fsync(target->directory) != 0 ||
      !readback(target, file, &original, size, expected, NULL, NULL, is_current, context) || !same_file(target, file, &original, size)) goto done;
  result = GENERAL_BACKUP_FILE_COMPLETE;
done:
  if (file >= 0 && close(file) != 0) result = GENERAL_BACKUP_FILE_UNCERTAIN;
  free(copy); return result;
}

bool general_history_archive_target_read(general_backup_target *target, unsigned char **ciphertext, size_t *size,
    bool (*is_current)(void *context), void *context) {
  if (ciphertext) *ciphertext = NULL;
  if (size) *size = 0;
  if (!target || !target->archive || atomic_exchange(&target->consumed, true) || !ciphertext || !size || !is_current ||
      !current(target, is_current, context)) return false;
  int file = openat(target->directory, target->name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (file < 0) return false;
  struct stat info;
  unsigned char *bytes = NULL;
  bool ok = fstat(file, &info) == 0 && S_ISREG(info.st_mode) && info.st_size > 0 && (uint64_t)info.st_size <= GENERAL_BACKUP_FILE_MAX_BYTES;
  if (ok) {
    bytes = malloc((size_t)info.st_size);
    ok = bytes && same_file(target, file, &info, (size_t)info.st_size) &&
      readback(target, file, &info, (size_t)info.st_size, NULL, bytes, target->read_digest, is_current, context);
  }
  if (!ok) { free(bytes); close(file); return false; }
  target->read_file = file; target->read_identity = info; target->read_size = (size_t)info.st_size;
  *ciphertext = bytes; *size = target->read_size;
  atomic_store(&target->read_ready, true); return true;
}

general_backup_file_result general_history_archive_target_verify(general_backup_target *target, const unsigned char expected_digest[32],
    bool (*is_current)(void *context), void *context) {
  if (!target || !target->archive || !atomic_exchange(&target->read_ready, false)) return GENERAL_BACKUP_FILE_UNAVAILABLE;
  unsigned char expected[32];
  general_backup_file_result result = GENERAL_BACKUP_FILE_UNCERTAIN;
  int file = target->read_file;
  if (!expected_digest || !is_current || file < 0) goto done;
  memcpy(expected, expected_digest, 32);
  if (memcmp(expected, target->read_digest, 32) != 0 || !current(target, is_current, context) ||
      !same_file(target, file, &target->read_identity, target->read_size) || fsync(file) != 0 ||
      !readback(target, file, &target->read_identity, target->read_size, expected, NULL, NULL, is_current, context) ||
      fsync(target->directory) != 0 || !readback(target, file, &target->read_identity, target->read_size, expected, NULL, NULL, is_current, context)) goto done;
  result = GENERAL_BACKUP_FILE_COMPLETE;
done:
  target->read_file = -1;
  if (file >= 0 && close(file) != 0) result = GENERAL_BACKUP_FILE_UNCERTAIN;
  return result;
}
