#ifndef KOINCODE_GENERAL_NATIVE_JOURNAL_FILES_H
#define KOINCODE_GENERAL_NATIVE_JOURNAL_FILES_H
#include <stdbool.h>
#include <stdint.h>

#define GENERAL_NATIVE_JOURNAL_BYTES (UINT64_C(512) * 1024 * 1024)
typedef struct general_native_journal_files general_native_journal_files;
typedef enum { GENERAL_NATIVE_FILE_DATABASE, GENERAL_NATIVE_FILE_WAL } general_native_file_role;
typedef enum { GENERAL_NATIVE_FILES_REJECTED, GENERAL_NATIVE_FILES_BUSY, GENERAL_NATIVE_FILES_CREATED, GENERAL_NATIVE_FILES_UNCERTAIN } general_native_files_creation;
/* Native-only retained files, not scope/authentication/SQLite-connection proof.
 * The original actor must verify namespace, peer and lease before opening.
 * Opens only the two fixed existing files; never creates or deletes data.
 * One owner per broker process. Caller keeps its input directory fd. Failed
 * cleanup returns a non-current, unreleasable owner for process-reap handling. */
general_native_journal_files *general_native_journal_files_open(int directory);
/* Explicit physical creation only, never a namespace/fresh/auth permission.
 * The actual native actor must supply its genuine one-time initialization gate
 * and verified fixed directory lifetime. Creates no directory, overwrites or
 * deletes nothing. Output must be empty; uncertain ownership stays retained. */
general_native_files_creation general_native_journal_files_create(int directory, bool (*current)(void *), void *context, general_native_journal_files **out);
/* Actual constructor origin and current zero sizes, not caller-provided truth. */
bool general_native_journal_files_created_empty(general_native_journal_files *files);
bool general_native_journal_files_current(general_native_journal_files *files);
bool general_native_journal_files_sizes(general_native_journal_files *files, uint64_t *database, uint64_t *wal);
bool general_native_journal_files_resize_allowed(general_native_journal_files *files, general_native_file_role role, uint64_t proposed_size);
/* One native IO loan per role. Never close the returned original fd; use only
 * its alias and release after the actual underlying IO owner has closed.
 * Closing another fd for this inode can release process-scoped POSIX locks. */
int general_native_journal_files_borrow(general_native_journal_files *files, general_native_file_role role);
bool general_native_journal_files_release(general_native_journal_files *files, general_native_file_role role);
/* Refuses live loans or a prior uncertain close. Never retries an fd close.
 * On uncertain close retain the owner until the dedicated broker is reaped. */
bool general_native_journal_files_close(general_native_journal_files **files);
#endif
