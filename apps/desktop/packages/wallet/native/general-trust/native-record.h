#ifndef KOINCODE_GENERAL_NATIVE_RECORD_H
#define KOINCODE_GENERAL_NATIVE_RECORD_H
#include "native-replay.h"
#include "session-installation.h"
#include "session-frame.h"

typedef enum { GENERAL_NATIVE_RECORD_INVALID, GENERAL_NATIVE_RECORD_UNAVAILABLE,
  GENERAL_NATIVE_RECORD_UNREGISTERED, GENERAL_NATIVE_RECORD_UNSETTLED,
  GENERAL_NATIVE_RECORD_CONFLICT, GENERAL_NATIVE_RECORD_FOUND } general_native_record_status;
typedef struct { unsigned char *bytes; size_t size; } general_native_record_bytes;
/* Private metadata read only. The genuine actor retains its verified anchor,
 * immutable matched replay, active/staging profile, command scope, peer/code/
 * profile/window/locks and original deadline. Inputs are not trust evidence.
 * Rejects source-key and signed bytes. UNREGISTERED is never missing/create.
 * Committed missing or changed data is CONFLICT. No Add/update/delete/retry.
 * Output must be empty; all failures preserve it. Success transfers owned bytes
 * within the protected actor only; never return them directly to a renderer. */
general_native_record_status general_native_record_read(const general_native_identity *identity,
  const general_session_installation *installation, const general_native_replay *replay,
  const char *profile_id, const char *reference, bool (*current)(void *), void *context, general_native_record_bytes *out);
/* Only for this adapter's successful output. Wipes the owned copy, not OS caches. */
void general_native_record_bytes_destroy(general_native_record_bytes *owned);
#endif
