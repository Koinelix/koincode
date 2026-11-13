#ifndef KOINCODE_GENERAL_NATIVE_JOURNAL_CONNECTION_H
#define KOINCODE_GENERAL_NATIVE_JOURNAL_CONNECTION_H
#include <stdbool.h>
#include <sqlite3.h>

typedef struct general_native_journal_connection general_native_journal_connection;
typedef enum {
  GENERAL_NATIVE_CONNECTION_CLOSED,
  GENERAL_NATIVE_CONNECTION_BUSY,
  GENERAL_NATIVE_CONNECTION_UNCERTAIN
} general_native_connection_close_result;
typedef enum {
  GENERAL_NATIVE_INITIALIZATION_REJECTED,
  GENERAL_NATIVE_INITIALIZATION_BUSY,
  GENERAL_NATIVE_INITIALIZATION_READY,
  GENERAL_NATIVE_INITIALIZATION_UNCERTAIN
} general_native_journal_initialization;
/* Native-private existing metadata journal only. The actor retains the verified
 * namespace and operation lease. No file creation, authentication or secrets. */
general_native_journal_connection *general_native_journal_connection_create(int directory);
/* Separate one-time physical bootstrap. The actual head-initialization actor
 * must establish the fresh root/auth/namespace gate, retaining the directory
 * lifetime. No caller SQL, path, head or permission boolean is accepted.
 * Output must be empty. Partial creation is retained, never deleted or retried. */
general_native_journal_initialization general_native_journal_connection_initialize(int directory,
  bool (*current)(void *), void *context, general_native_journal_connection **out);
bool general_native_journal_connection_open(general_native_journal_connection *owner, bool (*current)(void *), void *context);
bool general_native_journal_connection_current(general_native_journal_connection *owner);
/* Borrow only. Never sqlite3_close or export this pointer. One serial actor uses
 * fixed approved SQL; no second observer connection for the retained inodes. */
sqlite3 *general_native_journal_connection_database(general_native_journal_connection *owner);
/* A single native substage loan retains the original connection. Close is
 * BUSY without changing its lifetime until the actor returns this loan. */
bool general_native_journal_connection_borrow(general_native_journal_connection *owner);
bool general_native_journal_connection_return(general_native_journal_connection *owner);
/* BUSY retains ownership until statements drain. UNCERTAIN retains ownership
 * for process reaping; it does not authorize another close attempt. */
general_native_connection_close_result general_native_journal_connection_close(general_native_journal_connection **owner);
#endif
