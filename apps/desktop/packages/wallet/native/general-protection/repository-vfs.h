#ifndef KOINCODE_GENERAL_REPOSITORY_VFS_H
#define KOINCODE_GENERAL_REPOSITORY_VFS_H
#include "repository-files.h"
#include "sqlite/3.54.1/sqlite3.h"
typedef struct general_repository_vfs general_repository_vfs;
/* Private per-pair, non-default VFS. File loans are not native authority. */
general_repository_vfs *general_repository_vfs_create(general_repository_files *files);
bool general_repository_vfs_bootstrap_begin(general_repository_vfs *owner);
bool general_repository_vfs_bootstrap_end(general_repository_vfs *owner);
const char *general_repository_vfs_name(general_repository_vfs *owner);
const char *general_repository_vfs_filename(general_repository_vfs *owner, bool lease);
bool general_repository_vfs_current(general_repository_vfs *owner);
bool general_repository_vfs_matches(general_repository_vfs *owner, sqlite3 *database, bool lease);
/* Borrowed from this VFS's retained files, never caller path/FD projection.
 * Enclosing pair must retain its sole commit loan through real send/receipt. */
bool general_repository_vfs_commit_descriptors(general_repository_vfs *owner, int *database, int *lease);
bool general_repository_vfs_close_uncertain(general_repository_vfs *owner);
bool general_repository_vfs_destroy(general_repository_vfs **owner);
#endif
