#ifndef KOINCODE_GENERAL_REPOSITORY_PAIR_H
#define KOINCODE_GENERAL_REPOSITORY_PAIR_H
#include "repository-vfs.h"
typedef struct general_repository_pair general_repository_pair;
typedef enum { GENERAL_PAIR_CLOSED, GENERAL_PAIR_BUSY, GENERAL_PAIR_CLOSE_UNCERTAIN } general_repository_close_result;
/* Native-private factory, not an authorization boundary. The genuine resource
 * actor retains its original ticket, identity, scope and locks. No JS factory
 * may call this from a path/fd/create flag or expose these borrowed pointers. */
general_repository_open_result general_repository_pair_open(int directory, general_repository_kind kind, bool create,
  bool (*current)(void *), void *context, general_repository_pair **out);
bool general_repository_pair_current(general_repository_pair *owner);
/* Callback-safe file lifetime check; never prepares or steps SQLite. */
bool general_repository_pair_resources_current(general_repository_pair *owner);
bool general_repository_pair_kind(general_repository_pair *owner, general_repository_kind *kind);
bool general_repository_pair_borrow(general_repository_pair *owner);
/* Sealed native bridge only. Verifies this exact live SQLite/VFS pair and
 * borrows its actual database/lease for SCM_RIGHTS resource commit. No ordinary
 * JS FD factory. The same sole loan excludes SQL access and close until return.
 * Unknown commit keeps this pair/loan; return is never a resource receipt. */
bool general_repository_pair_commit_borrow(general_repository_pair *owner, int *database, int *writer_lease);
bool general_repository_pair_return(general_repository_pair *owner);
/* Fixed native recipe port only; never close or retain past the single loan. */
sqlite3 *general_repository_pair_database(general_repository_pair *owner);
general_repository_close_result general_repository_pair_close(general_repository_pair **owner);
#endif
