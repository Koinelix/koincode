#ifndef KOINCODE_GENERAL_NATIVE_DIRECTORY_H
#define KOINCODE_GENERAL_NATIVE_DIRECTORY_H
#include "native-head.h"
#include <stdbool.h>

typedef struct general_native_directory general_native_directory;
typedef enum { GENERAL_NATIVE_DIRECTORY_REJECTED, GENERAL_NATIVE_DIRECTORY_BUSY,
  GENERAL_NATIVE_DIRECTORY_UNCERTAIN, GENERAL_NATIVE_DIRECTORY_READY } general_native_directory_result;
/* Private physical IO, not initialization authority. Only the authenticated
 * head actor may request creation after its actual same-owner genesis Add.
 * Existing initialization always uses open-only. No caller-selected path. */
general_native_directory_result general_native_directory_open(const general_native_identity *identity, bool create,
  bool (*current)(void *), void *context, general_native_directory **out);
bool general_native_directory_current(general_native_directory *owner);
/* Frozen original physical identity association, still not assignment/auth. */
bool general_native_directory_matches(general_native_directory *owner, const general_native_identity *identity);
bool general_native_directory_borrow(general_native_directory *owner, int *directory);
bool general_native_directory_return(general_native_directory *owner);
/* One native-only physical lifetime handoff after actual assignment. Neither
 * callback nor this physical owner grants authentication, creation or record
 * authority. The original actor must keep both contexts alive through return;
 * the receiving connection still owns all per-command scope gates. */
bool general_native_directory_transfer_lifetime(general_native_directory *owner, bool (*current)(void *), void *context);
/* Independent loan of the original fixed enrollment parent of native/. Never
 * returns a caller-selected ancestor or permission to create a child. */
bool general_native_directory_enrollment_borrow(general_native_directory *owner, int *directory);
bool general_native_directory_enrollment_return(general_native_directory *owner);
/* A loan or unknown close retains the original owner. Never deletes files. */
bool general_native_directory_close(general_native_directory **owner);
#endif
