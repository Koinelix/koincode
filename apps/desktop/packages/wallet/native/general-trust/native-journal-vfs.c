#include "native-journal-vfs.h"
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char virtual_name[] = "/koincode-native-journal";
static const char virtual_wal[] = "/koincode-native-journal-wal";
static const char vfs_name[] = "koincode-native-journal";
typedef struct {
  sqlite3_file file;
  general_native_journal_vfs *owner;
  sqlite3_file *underlying;
  general_native_file_role role;
} journal_file;
struct general_native_journal_vfs {
  sqlite3_vfs vfs, *underlying;
  general_native_journal_files *files;
  sqlite3_filename aliases;
  sqlite3_file *live[2];
  bool borrowed[2], registered, main_used, faulted, close_uncertain, bootstrap_used, bootstrapping;
};
static const sqlite3_io_methods methods;
static bool resources(general_native_journal_vfs *owner) {
  return owner && general_native_journal_files_current(owner->files);
}
static int checked(journal_file *file, int result) {
  if (!resources(file->owner)) result = SQLITE_IOERR;
  if (result != SQLITE_OK && result != SQLITE_IOERR_SHORT_READ && result != SQLITE_BUSY && result != SQLITE_FULL && result != SQLITE_NOTFOUND)
    file->owner->faulted = true;
  return result;
}
static int close_file(sqlite3_file *raw) {
  journal_file *file = (journal_file *)raw;
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
  journal_file *file = (journal_file *)raw;
  if (!resources(file->owner) || count < 0 || offset < 0 || offset > INT64_MAX - count) return checked(file, SQLITE_IOERR_READ);
  return checked(file, file->underlying->pMethods->xRead(file->underlying, buffer, count, offset));
}
static int write_file(sqlite3_file *raw, const void *buffer, int count, sqlite3_int64 offset) {
  journal_file *file = (journal_file *)raw;
  uint64_t database, wal;
  if (count < 0 || offset < 0 || offset > INT64_MAX - count ||
      !general_native_journal_files_sizes(file->owner->files, &database, &wal)) return checked(file, SQLITE_IOERR_WRITE);
  uint64_t current = file->role == GENERAL_NATIVE_FILE_DATABASE ? database : wal;
  uint64_t end = (uint64_t)offset + (unsigned)count;
  if (!general_native_journal_files_resize_allowed(file->owner->files, file->role, end > current ? end : current)) return SQLITE_FULL;
  return checked(file, file->underlying->pMethods->xWrite(file->underlying, buffer, count, offset));
}
static int truncate_file(sqlite3_file *raw, sqlite3_int64 size) {
  journal_file *file = (journal_file *)raw;
  if (!resources(file->owner) || size < 0) return checked(file, SQLITE_IOERR_TRUNCATE);
  if (!general_native_journal_files_resize_allowed(file->owner->files, file->role, (uint64_t)size)) return SQLITE_FULL;
  return checked(file, file->underlying->pMethods->xTruncate(file->underlying, size));
}
static int sync_file(sqlite3_file *raw, int flags) {
  journal_file *file = (journal_file *)raw;
  if (!resources(file->owner)) return checked(file, SQLITE_IOERR_FSYNC);
  return checked(file, file->underlying->pMethods->xSync(file->underlying, flags));
}
static int size_file(sqlite3_file *raw, sqlite3_int64 *size) {
  journal_file *file = (journal_file *)raw;
  if (!resources(file->owner)) return checked(file, SQLITE_IOERR_FSTAT);
  return checked(file, file->underlying->pMethods->xFileSize(file->underlying, size));
}
static int lock_file(sqlite3_file *raw, int level) {
  journal_file *file = (journal_file *)raw;
  if (!resources(file->owner)) return checked(file, SQLITE_IOERR_LOCK);
  return checked(file, file->underlying->pMethods->xLock(file->underlying, level));
}
static int unlock_file(sqlite3_file *raw, int level) {
  journal_file *file = (journal_file *)raw;
  /* Drain locks on the original file even after identity invalidation. */
  return checked(file, file->underlying->pMethods->xUnlock(file->underlying, level));
}
static int reserved_file(sqlite3_file *raw, int *held) {
  journal_file *file = (journal_file *)raw;
  if (!resources(file->owner)) return checked(file, SQLITE_IOERR_CHECKRESERVEDLOCK);
  return checked(file, file->underlying->pMethods->xCheckReservedLock(file->underlying, held));
}
static int control_file(sqlite3_file *raw, int operation, void *argument) {
  journal_file *file = (journal_file *)raw;
  if (!resources(file->owner)) return checked(file, SQLITE_IOERR);
  switch (operation) {
    case SQLITE_FCNTL_FILE_POINTER: *(sqlite3_file **)argument = raw; return SQLITE_OK;
    case SQLITE_FCNTL_VFS_POINTER: *(sqlite3_vfs **)argument = &file->owner->vfs; return SQLITE_OK;
    case SQLITE_FCNTL_VFSNAME:
      *(char **)argument = sqlite3_mprintf("%s", vfs_name);
      return *(char **)argument ? SQLITE_OK : SQLITE_NOMEM;
    case SQLITE_FCNTL_SIZE_HINT: return SQLITE_NOTFOUND;
    case SQLITE_FCNTL_CHUNK_SIZE:
      if (*(int *)argument != 0) return SQLITE_NOTFOUND;
      break;
    case SQLITE_FCNTL_MMAP_SIZE: *(sqlite3_int64 *)argument = 0; return SQLITE_OK;
    case SQLITE_FCNTL_PERSIST_WAL: *(int *)argument = 1; break;
    case SQLITE_FCNTL_PRAGMA: {
      char **values = argument;
      if (values[2] && ((!sqlite3_stricmp(values[1], "locking_mode") && sqlite3_stricmp(values[2], "exclusive")) ||
          (!sqlite3_stricmp(values[1], "journal_mode") && sqlite3_stricmp(values[2], "wal") &&
            !(file->owner->bootstrapping && !sqlite3_stricmp(values[2], "memory"))))) return SQLITE_AUTH;
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
  journal_file *file = (journal_file *)raw;
  if (!resources(file->owner)) { file->owner->faulted = true; return 0; }
  return file->underlying->pMethods->xSectorSize(file->underlying);
}
static int characteristics_file(sqlite3_file *raw) {
  journal_file *file = (journal_file *)raw;
  if (!resources(file->owner)) { file->owner->faulted = true; return 0; }
  return file->underlying->pMethods->xDeviceCharacteristics(file->underlying) & ~SQLITE_IOCAP_BATCH_ATOMIC;
}
static int map_file(sqlite3_file *raw, int page, int size, int extend, void volatile **out) {
  journal_file *file = (journal_file *)raw;
  if (!resources(file->owner) || !file->underlying->pMethods->xShmMap) return checked(file, SQLITE_IOERR_SHMMAP);
  return checked(file, file->underlying->pMethods->xShmMap(file->underlying, page, size, extend, out));
}
static int shm_lock_file(sqlite3_file *raw, int offset, int count, int flags) {
  journal_file *file = (journal_file *)raw;
  if (!file->underlying->pMethods->xShmLock) return checked(file, SQLITE_IOERR_SHMLOCK);
  if (!resources(file->owner) && !(flags & SQLITE_SHM_UNLOCK)) return checked(file, SQLITE_IOERR_SHMLOCK);
  return checked(file, file->underlying->pMethods->xShmLock(file->underlying, offset, count, flags));
}
static void barrier_file(sqlite3_file *raw) {
  journal_file *file = (journal_file *)raw;
  if (file->underlying->pMethods->xShmBarrier) file->underlying->pMethods->xShmBarrier(file->underlying);
  if (!resources(file->owner)) file->owner->faulted = true;
}
static int unmap_file(sqlite3_file *raw, int remove) {
  journal_file *file = (journal_file *)raw;
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
  general_native_journal_vfs *owner = vfs->pAppData;
  memset(raw, 0, sizeof(journal_file));
  bool main = name && !strcmp(name, virtual_name) && (flags & SQLITE_OPEN_MAIN_DB);
  bool wal = name && !strcmp(name, virtual_wal) && (flags & SQLITE_OPEN_WAL);
  if (!general_native_journal_vfs_current(owner) || (!main && !wal) ||
      (flags & (SQLITE_OPEN_READONLY | SQLITE_OPEN_DELETEONCLOSE)) || !(flags & SQLITE_OPEN_READWRITE) ||
      (main && ((flags & SQLITE_OPEN_CREATE) || owner->main_used))) return SQLITE_CANTOPEN;
  unsigned role = wal ? GENERAL_NATIVE_FILE_WAL : GENERAL_NATIVE_FILE_DATABASE;
  if (owner->live[role]) return SQLITE_CANTOPEN;
  if (main) owner->main_used = true;
  sqlite3_file *underlying = calloc(1, (size_t)owner->underlying->szOsFile);
  if (!underlying) return SQLITE_NOMEM;
  const char *alias = wal ? sqlite3_filename_wal(owner->aliases) : sqlite3_filename_database(owner->aliases);
  int result = owner->underlying->xOpen(owner->underlying, alias, underlying,
    (flags & ~SQLITE_OPEN_CREATE) | SQLITE_OPEN_NOFOLLOW, out_flags);
  if (!underlying->pMethods) { free(underlying); return result == SQLITE_OK ? SQLITE_IOERR : result; }
  journal_file *file = (journal_file *)raw;
  file->owner = owner; file->underlying = underlying; file->role = (general_native_file_role)role;
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
  general_native_journal_vfs *owner = vfs->pAppData;
  uint64_t database, wal;
  if (!general_native_journal_files_sizes(owner->files, &database, &wal)) return SQLITE_IOERR_ACCESS;
  if (name && !strcmp(name, virtual_name)) *out = database > 0;
  else if (name && !strcmp(name, virtual_wal)) *out = wal > 0;
  else if (!name || (strcmp(name, "/koincode-native-journal-journal") && strcmp(name, "/koincode-native-journal-shm"))) return SQLITE_CANTOPEN;
  return SQLITE_OK;
}
static int full_path(sqlite3_vfs *vfs, const char *name, int size, char *out) {
  (void)vfs;
  if (!name || strcmp(name, virtual_name) || size < (int)sizeof(virtual_name)) return SQLITE_CANTOPEN;
  memcpy(out, virtual_name, sizeof(virtual_name)); return SQLITE_OK;
}
static void *load_library(sqlite3_vfs *vfs, const char *path) { (void)vfs; (void)path; return NULL; }
static void library_error(sqlite3_vfs *vfs, int size, char *out) { (void)vfs; if (size > 0) out[0] = 0; }
static void (*library_symbol(sqlite3_vfs *vfs, void *library, const char *name))(void) { (void)vfs; (void)library; (void)name; return NULL; }
static void close_library(sqlite3_vfs *vfs, void *library) { (void)vfs; (void)library; }
static int randomness(sqlite3_vfs *vfs, int size, char *out) {
  general_native_journal_vfs *owner = vfs->pAppData; return owner->underlying->xRandomness(owner->underlying, size, out);
}
static int sleep_vfs(sqlite3_vfs *vfs, int micros) {
  general_native_journal_vfs *owner = vfs->pAppData; return owner->underlying->xSleep(owner->underlying, micros);
}
static int time_vfs(sqlite3_vfs *vfs, double *out) {
  general_native_journal_vfs *owner = vfs->pAppData; return owner->underlying->xCurrentTime(owner->underlying, out);
}
static int time64_vfs(sqlite3_vfs *vfs, sqlite3_int64 *out) {
  general_native_journal_vfs *owner = vfs->pAppData; return owner->underlying->xCurrentTimeInt64(owner->underlying, out);
}
static int error_vfs(sqlite3_vfs *vfs, int size, char *out) { (void)vfs; if (size > 0) out[0] = 0; return 0; }
general_native_journal_vfs *general_native_journal_vfs_create(general_native_journal_files *files) {
  sqlite3_vfs *underlying = sqlite3_vfs_find("unix-excl");
  if (!general_native_journal_files_current(files) || !underlying || underlying->iVersion < 2 || !underlying->xCurrentTimeInt64 ||
      sqlite3_vfs_find(vfs_name)) return NULL;
  general_native_journal_vfs *owner = calloc(1, sizeof(*owner));
  if (!owner) return NULL;
  owner->files = files; owner->underlying = underlying;
  int descriptors[2] = { -1, -1 };
  for (unsigned i = 0; i < 2; i++) { descriptors[i] = general_native_journal_files_borrow(files, (general_native_file_role)i); owner->borrowed[i] = descriptors[i] >= 0; }
  char database[48], wal[48];
  if (descriptors[0] >= 0 && descriptors[1] >= 0 &&
      snprintf(database, sizeof(database), "/dev/fd/%d", descriptors[0]) > 0 && snprintf(wal, sizeof(wal), "/dev/fd/%d", descriptors[1]) > 0)
    owner->aliases = sqlite3_create_filename(database, "", wal, 0, NULL);
  owner->vfs = (sqlite3_vfs){ .iVersion = 2, .szOsFile = sizeof(journal_file), .mxPathname = 128,
    .zName = vfs_name, .pAppData = owner, .xOpen = open_file, .xDelete = delete_file, .xAccess = access_file,
    .xFullPathname = full_path, .xDlOpen = load_library, .xDlError = library_error, .xDlSym = library_symbol,
    .xDlClose = close_library, .xRandomness = randomness, .xSleep = sleep_vfs, .xCurrentTime = time_vfs,
    .xGetLastError = error_vfs, .xCurrentTimeInt64 = time64_vfs };
  if (owner->aliases && sqlite3_vfs_register(&owner->vfs, 0) == SQLITE_OK) { owner->registered = true; return owner; }
  general_native_journal_vfs_destroy(&owner); return NULL;
}
const char *general_native_journal_vfs_name(general_native_journal_vfs *owner) { return owner && owner->registered ? vfs_name : NULL; }
const char *general_native_journal_vfs_filename(void) { return virtual_name; }
bool general_native_journal_vfs_bootstrap_begin(general_native_journal_vfs *owner) {
  if (!general_native_journal_vfs_current(owner) || owner->main_used || owner->bootstrap_used ||
      !general_native_journal_files_created_empty(owner->files)) return false;
  owner->bootstrap_used = owner->bootstrapping = true; return true;
}
bool general_native_journal_vfs_bootstrap_end(general_native_journal_vfs *owner) {
  if (!owner || !owner->bootstrapping) return false;
  owner->bootstrapping = false; return general_native_journal_vfs_current(owner);
}
bool general_native_journal_vfs_current(general_native_journal_vfs *owner) {
  return owner && !owner->faulted && !owner->close_uncertain && resources(owner);
}
bool general_native_journal_vfs_matches(general_native_journal_vfs *owner, sqlite3 *database) {
  sqlite3_file *main = NULL, *wal = NULL; sqlite3_vfs *vfs = NULL;
  if (!database || !general_native_journal_vfs_current(owner) ||
      sqlite3_file_control(database, "main", SQLITE_FCNTL_FILE_POINTER, &main) != SQLITE_OK || !main || main->pMethods != &methods ||
      sqlite3_file_control(database, "main", SQLITE_FCNTL_JOURNAL_POINTER, &wal) != SQLITE_OK ||
      sqlite3_file_control(database, "main", SQLITE_FCNTL_VFS_POINTER, &vfs) != SQLITE_OK || vfs != &owner->vfs) return false;
  journal_file *file = (journal_file *)main;
  if (file->owner != owner || file->role != GENERAL_NATIVE_FILE_DATABASE || owner->live[0] != file->underlying) return false;
  if (wal) {
    if (wal->pMethods != &methods) return false;
    file = (journal_file *)wal;
    if (file->owner != owner || file->role != GENERAL_NATIVE_FILE_WAL || owner->live[1] != file->underlying) return false;
  }
  return true;
}
bool general_native_journal_vfs_destroy(general_native_journal_vfs **pointer) {
  if (!pointer || !*pointer) return true;
  general_native_journal_vfs *owner = *pointer;
  if (owner->close_uncertain || owner->live[0] || owner->live[1]) return false;
  if (owner->registered && sqlite3_vfs_unregister(&owner->vfs) != SQLITE_OK) return false;
  owner->registered = false;
  if (owner->aliases) { sqlite3_free_filename(owner->aliases); owner->aliases = NULL; }
  for (unsigned i = 0; i < 2; i++) if (owner->borrowed[i]) {
    if (!general_native_journal_files_release(owner->files, (general_native_file_role)i)) return false;
    owner->borrowed[i] = false;
  }
  free(owner); *pointer = NULL; return true;
}
