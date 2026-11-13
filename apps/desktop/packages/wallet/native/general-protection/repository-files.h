#ifndef KOINCODE_GENERAL_REPOSITORY_FILES_H
#define KOINCODE_GENERAL_REPOSITORY_FILES_H
#include <stdbool.h>
#include <stdint.h>
#include <sys/stat.h>
#define GENERAL_REPOSITORY_BYTES (UINT64_C(512) * 1024 * 1024)
typedef struct general_repository_files general_repository_files;
typedef enum { GENERAL_REPOSITORY_STATE, GENERAL_REPOSITORY_SIGNING } general_repository_kind;
typedef enum { GENERAL_REPOSITORY_DATABASE, GENERAL_REPOSITORY_LEASE, GENERAL_REPOSITORY_WAL } general_repository_role;
typedef enum { GENERAL_REPOSITORY_REJECTED, GENERAL_REPOSITORY_READY, GENERAL_REPOSITORY_UNCERTAIN } general_repository_open_result;
/* Native-private file ownership, not resource/session authentication. The real
 * actor must hold the original resource ticket, origin, parent/UID locks and
 * committed identities. Only resource.start permits create; open requires its
 * original created record. No JS path/fd/boolean may establish those facts.
 * current is the genuine actor's earlier scope/operation deadline. Construction
 * additionally has one total 30-second monotonic budget. No data is deleted. */
general_repository_open_result general_repository_files_open(int directory, general_repository_kind kind, bool create,
  bool (*current)(void *), void *context, general_repository_files **out);
bool general_repository_files_created_empty(general_repository_files *owner);
bool general_repository_files_current(general_repository_files *owner);
bool general_repository_files_sizes(general_repository_files *owner, uint64_t sizes[3]);
bool general_repository_files_resize_allowed(general_repository_files *owner, general_repository_role role, uint64_t size);
/* Native VFS/commit only. One loan per role; return records drainage even after
 * revocation. No SQLite handle or resource permission is conferred. */
int general_repository_files_borrow(general_repository_files *owner, general_repository_role role);
bool general_repository_files_return(general_repository_files *owner, general_repository_role role);
bool general_repository_files_identity(general_repository_files *owner, general_repository_role role, struct stat *out);
/* Unknown or loaned close keeps the owner. Never retry an unknown syscall. */
bool general_repository_files_close(general_repository_files **owner);
#endif
