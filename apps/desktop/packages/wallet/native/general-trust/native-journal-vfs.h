#ifndef KOINCODE_GENERAL_NATIVE_JOURNAL_VFS_H
#define KOINCODE_GENERAL_NATIVE_JOURNAL_VFS_H
#include "native-journal-files.h"
#include <sqlite3.h>

typedef struct general_native_journal_vfs general_native_journal_vfs;
/* Native-private IO owner. Borrows both retained files until actual SQLite
 * files close. Never a namespace, authentication or signing capability. */
general_native_journal_vfs *general_native_journal_vfs_create(general_native_journal_files *files);
/* One internal schema-bootstrap window, only for this process's actual fresh
 * empty constructor. Must seal before exposing the connection; never authority. */
bool general_native_journal_vfs_bootstrap_begin(general_native_journal_vfs *owner);
bool general_native_journal_vfs_bootstrap_end(general_native_journal_vfs *owner);
const char *general_native_journal_vfs_name(general_native_journal_vfs *owner);
const char *general_native_journal_vfs_filename(void);
bool general_native_journal_vfs_current(general_native_journal_vfs *owner);
bool general_native_journal_vfs_matches(general_native_journal_vfs *owner, sqlite3 *database);
/* False retains the owner and loans after live or uncertain underlying close. */
bool general_native_journal_vfs_destroy(general_native_journal_vfs **owner);
#endif
