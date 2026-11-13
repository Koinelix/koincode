#include "repository-vfs.h"
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  sqlite3_file file;
  general_repository_vfs *owner;
  sqlite3_file *underlying;
  general_repository_role role;
} repository_file;
struct general_repository_vfs {
  sqlite3_vfs vfs, *underlying;
  general_repository_files *files;
  sqlite3_filename aliases, lease_alias;
  char name[80], main_name[88], lease_name[88], wal_name[96];
  sqlite3_file *live[3];
  int descriptors[3];
  bool borrowed[3], registered, main_used[2], faulted, close_uncertain, bootstrap_used, bootstrapping;
};
static const sqlite3_io_methods methods;
static bool resources(general_repository_vfs *owner) {
  return owner && !owner->faulted && general_repository_files_current(owner->files);
}
static int checked(repository_file *file, int result) {
  if (!resources(file->owner)) result = SQLITE_IOERR;
  if (result != SQLITE_OK && result != SQLITE_IOERR_SHORT_READ && result != SQLITE_BUSY && result != SQLITE_FULL && result != SQLITE_NOTFOUND)
    file->owner->faulted = true;
  return result;
}
static int close_file(sqlite3_file *raw) {
  repository_file *file = (repository_file *)raw;
  int result = file->underlying->pMethods->xClose(file->underlying);
  if (result == SQLITE_OK) {
    file->owner->live[file->role] = NULL;
    free(file->underlying);
  } else {
    /* SQLite can discard raw even on error. Keep the actual allocation and
     * retained fd loans in the owner, never call its xClose a second time. */
    file->owner->close_uncertain = file->owner->faulted = true;
  }
  file->underlying = NULL; raw->pMethods = NULL;
  return result;
}
static int read_file(sqlite3_file *raw, void *buffer, int count, sqlite3_int64 offset) {
  repository_file *file = (repository_file *)raw;
  if (!resources(file->owner) || count < 0 || offset < 0 || offset > INT64_MAX - count) return checked(file, SQLITE_IOERR_READ);
  return checked(file, file->underlying->pMethods->xRead(file->underlying, buffer, count, offset));
}
static int write_file(sqlite3_file *raw, const void *buffer, int count, sqlite3_int64 offset) {
  repository_file *file = (repository_file *)raw;
  uint64_t sizes[3];
  if (count < 0 || offset < 0 || offset > INT64_MAX - count ||
      !general_repository_files_sizes(file->owner->files, sizes)) return checked(file, SQLITE_IOERR_WRITE);
  uint64_t current = sizes[file->role];
  uint64_t end = (uint64_t)offset + (unsigned)count;
  if (!general_repository_files_resize_allowed(file->owner->files, file->role, end > current ? end : current)) return SQLITE_FULL;
  return checked(file, file->underlying->pMethods->xWrite(file->underlying, buffer, count, offset));
}
static int truncate_file(sqlite3_file *raw, sqlite3_int64 size) {
  repository_file *file = (repository_file *)raw;
  if (!resources(file->owner) || size < 0) return checked(file, SQLITE_IOERR_TRUNCATE);
  if (!general_repository_files_resize_allowed(file->owner->files, file->role, (uint64_t)size)) return SQLITE_FULL;
  return checked(file, file->underlying->pMethods->xTruncate(file->underlying, size));
}
static int sync_file(sqlite3_file *raw, int flags) {
  repository_file *file = (repository_file *)raw;
  if (!resources(file->owner)) return checked(file, SQLITE_IOERR_FSYNC);
  return checked(file, file->underlying->pMethods->xSync(file->underlying, flags));
}
static int size_file(sqlite3_file *raw, sqlite3_int64 *size) {
  repository_file *file = (repository_file *)raw;
  if (!resources(file->owner)) return checked(file, SQLITE_IOERR_FSTAT);
  return checked(file, file->underlying->pMethods->xFileSize(file->underlying, size));
}
static int lock_file(sqlite3_file *raw, int level) {
  repository_file *file = (repository_file *)raw;
  if (!resources(file->owner)) return checked(file, SQLITE_IOERR_LOCK);
  return checked(file, file->underlying->pMethods->xLock(file->underlying, level));
}
static int unlock_file(sqlite3_file *raw, int level) {
  repository_file *file = (repository_file *)raw;
  /* Drain locks on the original file even after identity invalidation. */
  return checked(file, file->underlying->pMethods->xUnlock(file->underlying, level));
}
static int reserved_file(sqlite3_file *raw, int *held) {
  repository_file *file = (repository_file *)raw;
  if (!resources(file->owner)) return checked(file, SQLITE_IOERR_CHECKRESERVEDLOCK);
  return checked(file, file->underlying->pMethods->xCheckReservedLock(file->underlying, held));
}
static int control_file(sqlite3_file *raw, int operation, void *argument) {
  repository_file *file = (repository_file *)raw;
  if (!resources(file->owner)) return checked(file, SQLITE_IOERR);
  switch (operation) {
    case SQLITE_FCNTL_FILE_POINTER: *(sqlite3_file **)argument = raw; return SQLITE_OK;
    case SQLITE_FCNTL_VFS_POINTER: *(sqlite3_vfs **)argument = &file->owner->vfs; return SQLITE_OK;
    case SQLITE_FCNTL_VFSNAME:
      *(char **)argument = sqlite3_mprintf("%s", file->owner->name);
      return *(char **)argument ? SQLITE_OK : SQLITE_NOMEM;
    case SQLITE_FCNTL_SIZE_HINT: return SQLITE_NOTFOUND;
    case SQLITE_FCNTL_CHUNK_SIZE:
      if (*(int *)argument != 0) return SQLITE_NOTFOUND;
      break;
    case SQLITE_FCNTL_MMAP_SIZE: *(sqlite3_int64 *)argument = 0; return SQLITE_OK;
    case SQLITE_FCNTL_PERSIST_WAL: *(int *)argument = 1; break;
    case SQLITE_FCNTL_PRAGMA: {
      char **values = argument;
      if (values[2] && !sqlite3_stricmp(values[1], "locking_mode") && sqlite3_stricmp(values[2], "exclusive")) return SQLITE_AUTH;
      if (values[2] && !sqlite3_stricmp(values[1], "journal_mode")) {
        bool allowed = file->role == GENERAL_REPOSITORY_LEASE ? !sqlite3_stricmp(values[2], "memory") :
          !sqlite3_stricmp(values[2], "wal") || (file->owner->bootstrapping && !sqlite3_stricmp(values[2], "memory"));
        if (!allowed) return SQLITE_AUTH;
      }
      return SQLITE_NOTFOUND;
    }
    case SQLITE_FCNTL_LOCKSTATE: case SQLITE_FCNTL_LAST_ERRNO: case SQLITE_FCNTL_HAS_MOVED:
    case SQLITE_FCNTL_DATA_VERSION: case SQLITE_FCNTL_SYNC: case SQLITE_FCNTL_COMMIT_PHASETWO:
    case SQLITE_FCNTL_CKPT_START: case SQLITE_FCNTL_CKPT_DONE: break;
    default: return SQLITE_NOTFOUND;
  }
  return checked(file, file->underlying->pMethods->xFileControl(file->underlying, operation, argument));
}
static int sector_file(sqlite3_file *raw) {
  repository_file *file = (repository_file *)raw;
  if (!resources(file->owner)) { file->owner->faulted = true; return 0; }
  return file->underlying->pMethods->xSectorSize(file->underlying);
}
static int characteristics_file(sqlite3_file *raw) {
  repository_file *file = (repository_file *)raw;
  if (!resources(file->owner)) { file->owner->faulted = true; return 0; }
  return file->underlying->pMethods->xDeviceCharacteristics(file->underlying) & ~SQLITE_IOCAP_BATCH_ATOMIC;
}
static int map_file(sqlite3_file *raw, int page, int size, int extend, void volatile **out) {
  repository_file *file = (repository_file *)raw;
  if (!resources(file->owner) || !file->underlying->pMethods->xShmMap) return checked(file, SQLITE_IOERR_SHMMAP);
  return checked(file, file->underlying->pMethods->xShmMap(file->underlying, page, size, extend, out));
}
static int shm_lock_file(sqlite3_file *raw, int offset, int count, int flags) {
  repository_file *file = (repository_file *)raw;
  if (!file->underlying->pMethods->xShmLock) return checked(file, SQLITE_IOERR_SHMLOCK);
  if (!resources(file->owner) && !(flags & SQLITE_SHM_UNLOCK)) return checked(file, SQLITE_IOERR_SHMLOCK);
  return checked(file, file->underlying->pMethods->xShmLock(file->underlying, offset, count, flags));
}
static void barrier_file(sqlite3_file *raw) {
  repository_file *file = (repository_file *)raw;
  if (file->underlying->pMethods->xShmBarrier) file->underlying->pMethods->xShmBarrier(file->underlying);
  if (!resources(file->owner)) file->owner->faulted = true;
}
static int unmap_file(sqlite3_file *raw, int remove) {
  repository_file *file = (repository_file *)raw;
  if (!file->underlying->pMethods->xShmUnmap) return checked(file, SQLITE_IOERR_SHMMAP);
  return checked(file, file->underlying->pMethods->xShmUnmap(file->underlying, remove));
}
static const sqlite3_io_methods methods = {
  .iVersion = 2, .xClose = close_file, .xRead = read_file, .xWrite = write_file, .xTruncate = truncate_file,
  .xSync = sync_file, .xFileSize = size_file, .xLock = lock_file, .xUnlock = unlock_file,
  .xCheckReservedLock = reserved_file, .xFileControl = control_file, .xSectorSize = sector_file,
  .xDeviceCharacteristics = characteristics_file, .xShmMap = map_file, .xShmLock = shm_lock_file,
  .xShmBarrier = barrier_file, .xShmUnmap = unmap_file
};
static int open_file(sqlite3_vfs *vfs, sqlite3_filename name, sqlite3_file *raw, int flags, int *out_flags) {
  general_repository_vfs *owner = vfs->pAppData;
  memset(raw, 0, sizeof(repository_file));
  bool main = name && !strcmp(name, owner->main_name) && (flags & SQLITE_OPEN_MAIN_DB);
  bool lease = name && !strcmp(name, owner->lease_name) && (flags & SQLITE_OPEN_MAIN_DB);
  bool wal = name && !strcmp(name, owner->wal_name) && (flags & SQLITE_OPEN_WAL);
  if (!general_repository_vfs_current(owner) || (!main && !lease && !wal) ||
      (flags & (SQLITE_OPEN_READONLY | SQLITE_OPEN_DELETEONCLOSE)) || !(flags & SQLITE_OPEN_READWRITE) ||
      ((main || lease) && ((flags & SQLITE_OPEN_CREATE) || owner->main_used[lease ? 1 : 0]))) return SQLITE_CANTOPEN;
  unsigned role = wal ? GENERAL_REPOSITORY_WAL : lease ? GENERAL_REPOSITORY_LEASE : GENERAL_REPOSITORY_DATABASE;
  if (owner->live[role]) return SQLITE_CANTOPEN;
  if (main || lease) owner->main_used[lease ? 1 : 0] = true;
  sqlite3_file *underlying = calloc(1, (size_t)owner->underlying->szOsFile);
  if (!underlying) return SQLITE_NOMEM;
  const char *alias = wal ? sqlite3_filename_wal(owner->aliases) :
    sqlite3_filename_database(lease ? owner->lease_alias : owner->aliases);
  int result = owner->underlying->xOpen(owner->underlying, alias, underlying,
    (flags & ~SQLITE_OPEN_CREATE) | SQLITE_OPEN_NOFOLLOW, out_flags);
  if (!underlying->pMethods) { free(underlying); return result == SQLITE_OK ? SQLITE_IOERR : result; }
  repository_file *file = (repository_file *)raw;
  file->owner = owner; file->underlying = underlying; file->role = (general_repository_role)role;
  owner->live[role] = underlying; raw->pMethods = &methods;
  if (result == SQLITE_OK) {
    int chunk = 0, persist = 1; sqlite3_int64 mmap = 0;
    result = underlying->pMethods->xFileControl(underlying, SQLITE_FCNTL_CHUNK_SIZE, &chunk);
    if (result == SQLITE_OK) result = underlying->pMethods->xFileControl(underlying, SQLITE_FCNTL_MMAP_SIZE, &mmap);
    if (result == SQLITE_OK) result = underlying->pMethods->xFileControl(underlying, SQLITE_FCNTL_PERSIST_WAL, &persist);
  }
  return checked(file, result);
}
static int delete_file(sqlite3_vfs *vfs, const char *name, int sync) {
  (void)vfs; (void)name; (void)sync; return SQLITE_IOERR_DELETE;
}
static int access_file(sqlite3_vfs *vfs, const char *name, int flags, int *out) {
  (void)flags; *out = 0;
  general_repository_vfs *owner = vfs->pAppData;
  uint64_t sizes[3];
  if (!general_repository_files_sizes(owner->files, sizes)) return SQLITE_IOERR_ACCESS;
  if (name && !strcmp(name, owner->main_name)) *out = sizes[0] > 0;
  else if (name && !strcmp(name, owner->lease_name)) *out = sizes[1] > 0;
  else if (name && !strcmp(name, owner->wal_name)) *out = sizes[2] > 0;
  else {
    bool expected = false; char sidecar[100];
    for (unsigned i = 0; i < 2; i++) for (unsigned j = 0; j < 3; j++) {
      snprintf(sidecar, sizeof(sidecar), "%s%s", i ? owner->lease_name : owner->main_name,
        j == 0 ? "-journal" : j == 1 ? "-shm" : "-wal");
      if (name && !strcmp(name, sidecar)) expected = true;
    }
    if (!expected) return SQLITE_CANTOPEN;
  }
  return SQLITE_OK;
}
static int full_path(sqlite3_vfs *vfs, const char *name, int size, char *out) {
  general_repository_vfs *owner = vfs->pAppData;
  if (!name || (strcmp(name, owner->main_name) && strcmp(name, owner->lease_name)) || size <= (int)strlen(name)) return SQLITE_CANTOPEN;
  memcpy(out, name, strlen(name) + 1); return SQLITE_OK;
}
static void *load_library(sqlite3_vfs *vfs, const char *path) { (void)vfs; (void)path; return NULL; }
static void library_error(sqlite3_vfs *vfs, int size, char *out) { (void)vfs; if (size > 0) out[0] = 0; }
static void (*library_symbol(sqlite3_vfs *vfs, void *library, const char *name))(void) { (void)vfs; (void)library; (void)name; return NULL; }
static void close_library(sqlite3_vfs *vfs, void *library) { (void)vfs; (void)library; }
static int randomness(sqlite3_vfs *vfs, int size, char *out) {
  general_repository_vfs *owner = vfs->pAppData; return owner->underlying->xRandomness(owner->underlying, size, out);
}
static int sleep_vfs(sqlite3_vfs *vfs, int micros) {
  general_repository_vfs *owner = vfs->pAppData; return owner->underlying->xSleep(owner->underlying, micros);
}
static int time_vfs(sqlite3_vfs *vfs, double *out) {
  general_repository_vfs *owner = vfs->pAppData; return owner->underlying->xCurrentTime(owner->underlying, out);
}
static int time64_vfs(sqlite3_vfs *vfs, sqlite3_int64 *out) {
  general_repository_vfs *owner = vfs->pAppData; return owner->underlying->xCurrentTimeInt64(owner->underlying, out);
}
static int error_vfs(sqlite3_vfs *vfs, int size, char *out) { (void)vfs; if (size > 0) out[0] = 0; return 0; }
general_repository_vfs *general_repository_vfs_create(general_repository_files *files) {
  sqlite3_vfs *underlying = sqlite3_vfs_find("unix-excl");
  if (!general_repository_files_current(files) || !underlying || underlying->iVersion < 2 || !underlying->xCurrentTimeInt64) return NULL;
  general_repository_vfs *owner = calloc(1, sizeof(*owner));
  if (!owner) return NULL;
  owner->files = files; owner->underlying = underlying;
  unsigned char nonce[16]; arc4random_buf(nonce, sizeof(nonce));
  strcpy(owner->name, "koincode-repository-");
  for (unsigned i = 0; i < sizeof(nonce); i++) snprintf(owner->name + 19 + 2 * i, 3, "%02x", nonce[i]);
  if (sqlite3_vfs_find(owner->name)) { free(owner); return NULL; }
  snprintf(owner->main_name, sizeof(owner->main_name), "/%s-main", owner->name);
  snprintf(owner->lease_name, sizeof(owner->lease_name), "/%s-lease", owner->name);
  snprintf(owner->wal_name, sizeof(owner->wal_name), "%s-wal", owner->main_name);
  int descriptors[3] = { -1, -1, -1 };
  for (unsigned i = 0; i < 3; i++) { descriptors[i] = general_repository_files_borrow(files, (general_repository_role)i); owner->descriptors[i] = descriptors[i]; owner->borrowed[i] = descriptors[i] >= 0; }
  char database[48], lease[48], wal[48];
  if (descriptors[0] >= 0 && descriptors[1] >= 0 && descriptors[2] >= 0 &&
      snprintf(database, sizeof(database), "/dev/fd/%d", descriptors[0]) > 0 &&
      snprintf(lease, sizeof(lease), "/dev/fd/%d", descriptors[1]) > 0 && snprintf(wal, sizeof(wal), "/dev/fd/%d", descriptors[2]) > 0) {
    owner->aliases = sqlite3_create_filename(database, "", wal, 0, NULL);
    owner->lease_alias = sqlite3_create_filename(lease, "", "", 0, NULL);
  }
  owner->vfs = (sqlite3_vfs){ .iVersion = 2, .szOsFile = sizeof(repository_file), .mxPathname = 128,
    .zName = owner->name, .pAppData = owner, .xOpen = open_file, .xDelete = delete_file, .xAccess = access_file,
    .xFullPathname = full_path, .xDlOpen = load_library, .xDlError = library_error, .xDlSym = library_symbol,
    .xDlClose = close_library, .xRandomness = randomness, .xSleep = sleep_vfs, .xCurrentTime = time_vfs,
    .xGetLastError = error_vfs, .xCurrentTimeInt64 = time64_vfs };
  if (owner->aliases && owner->lease_alias && sqlite3_vfs_register(&owner->vfs, 0) == SQLITE_OK) { owner->registered = true; return owner; }
  general_repository_vfs_destroy(&owner); return NULL;
}
const char *general_repository_vfs_name(general_repository_vfs *owner) { return owner && owner->registered ? owner->name : NULL; }
const char *general_repository_vfs_filename(general_repository_vfs *owner, bool lease) { return owner ? lease ? owner->lease_name : owner->main_name : NULL; }
bool general_repository_vfs_bootstrap_begin(general_repository_vfs *owner) {
  if (!general_repository_vfs_current(owner) || owner->main_used[0] || owner->main_used[1] || owner->bootstrap_used ||
      !general_repository_files_created_empty(owner->files)) return false;
  owner->bootstrap_used = owner->bootstrapping = true; return true;
}
bool general_repository_vfs_bootstrap_end(general_repository_vfs *owner) {
  if (!owner || !owner->bootstrapping) return false;
  owner->bootstrapping = false; return general_repository_vfs_current(owner);
}
bool general_repository_vfs_current(general_repository_vfs *owner) {
  return owner && !owner->faulted && !owner->close_uncertain && resources(owner);
}
bool general_repository_vfs_matches(general_repository_vfs *owner, sqlite3 *database, bool lease) {
  sqlite3_file *main = NULL, *wal = NULL; sqlite3_vfs *vfs = NULL;
  if (!database || !general_repository_vfs_current(owner) ||
      sqlite3_file_control(database, "main", SQLITE_FCNTL_FILE_POINTER, &main) != SQLITE_OK || !main || main->pMethods != &methods ||
      sqlite3_file_control(database, "main", SQLITE_FCNTL_JOURNAL_POINTER, &wal) != SQLITE_OK ||
      sqlite3_file_control(database, "main", SQLITE_FCNTL_VFS_POINTER, &vfs) != SQLITE_OK || vfs != &owner->vfs) return false;
  repository_file *file = (repository_file *)main;
  if (file->owner != owner || file->role != (lease ? GENERAL_REPOSITORY_LEASE : GENERAL_REPOSITORY_DATABASE) || owner->live[lease ? 1 : 0] != file->underlying) return false;
  /* The private lease uses SQLite MEMORY rollback, not a retained WAL file.
   * Its actual journal mode is checked by the pair before admission. */
  if (wal && !lease) {
    if (wal->pMethods != &methods) return false;
    file = (repository_file *)wal;
    if (file->owner != owner || file->role != GENERAL_REPOSITORY_WAL || owner->live[2] != file->underlying) return false;
  }
  return true;
}
bool general_repository_vfs_commit_descriptors(general_repository_vfs *owner, int *database, int *lease) {
  if (!database || !lease || !general_repository_vfs_current(owner) || !owner->borrowed[0] || !owner->borrowed[1] ||
      !owner->live[0] || !owner->live[1] || owner->descriptors[0] < 0 || owner->descriptors[1] < 0) return false;
  *database = owner->descriptors[0]; *lease = owner->descriptors[1]; return true;
}
bool general_repository_vfs_close_uncertain(general_repository_vfs *owner) { return owner && owner->close_uncertain; }
bool general_repository_vfs_destroy(general_repository_vfs **pointer) {
  if (!pointer || !*pointer) return true;
  general_repository_vfs *owner = *pointer;
  if (owner->close_uncertain || owner->live[0] || owner->live[1] || owner->live[2]) return false;
  if (owner->registered && sqlite3_vfs_unregister(&owner->vfs) != SQLITE_OK) return false;
  owner->registered = false;
  if (owner->aliases) { sqlite3_free_filename(owner->aliases); owner->aliases = NULL; }
  if (owner->lease_alias) { sqlite3_free_filename(owner->lease_alias); owner->lease_alias = NULL; }
  for (unsigned i = 0; i < 3; i++) if (owner->borrowed[i]) {
    if (!general_repository_files_return(owner->files, (general_repository_role)i)) return false;
    owner->borrowed[i] = false;
  }
  free(owner); *pointer = NULL; return true;
}
